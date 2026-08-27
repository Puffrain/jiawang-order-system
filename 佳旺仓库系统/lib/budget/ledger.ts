import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface BudgetLimits {
  dailyTokenLimit: number;
  perTaskTokenLimit: number;
  /** Integer minor currency units per token (e.g. micro-USD). */
  costPerTokenMinor?: number;
  /** Optional provider price-table rates.  Values are integer minor units per
   * token; keeping them in the ledger makes each settlement auditable even if
   * the admin changes pricing later. */
  promptCostPerTokenMinor?: number;
  completionCostPerTokenMinor?: number;
  priceVersion?: string;
  currency?: string;
}

export interface LedgerTask {
  taskId: string;
  day: string;
  reservedTokens: number;
  usedTokens: number;
  costMinor: number;
  status: "reserved" | "settled" | "paused" | "refunded";
  usageKnown: boolean;
  promptTokens?: number;
  completionTokens?: number;
  priceVersion?: string;
  currency?: string;
  promptCostPerTokenMinor?: number;
  completionCostPerTokenMinor?: number;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  taskId: string;
  kind: "reserve" | "settle" | "pause" | "refund";
  tokens: number;
  costMinor: number;
  at: string;
}

export interface LedgerState {
  version: 1;
  day: string;
  dailyReserved: number;
  dailyUsed: number;
  tasks: Record<string, LedgerTask>;
  entries: LedgerEntry[];
}

export interface BudgetStateBackend {
  load(): LedgerState | undefined;
  save(state: LedgerState): void;
}

export class BudgetError extends Error {
  readonly code: string;
  readonly class = "budget" as const;
  readonly retryable = false;
  readonly pause = true;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
    this.details = details;
  }
}

export class TokenLedger {
  readonly filePath: string;
  readonly limits: Required<BudgetLimits>;
  private state: LedgerState;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly backend?: BudgetStateBackend;

  constructor(filePath = process.env.PIPELINE_BUDGET_FILE || path.join(process.cwd(), "data", "pipeline-budget.json"), limits: BudgetLimits = { dailyTokenLimit: 2_000_000, perTaskTokenLimit: 100_000, costPerTokenMinor: 0 }, backend?: BudgetStateBackend) {
    this.filePath = path.resolve(filePath);
    this.limits = {
      dailyTokenLimit: requireInteger(limits.dailyTokenLimit, "dailyTokenLimit"),
      perTaskTokenLimit: requireInteger(limits.perTaskTokenLimit, "perTaskTokenLimit"),
      costPerTokenMinor: requireInteger(limits.costPerTokenMinor ?? 0, "costPerTokenMinor"),
      promptCostPerTokenMinor: requireInteger(limits.promptCostPerTokenMinor ?? limits.costPerTokenMinor ?? 0, "promptCostPerTokenMinor"),
      completionCostPerTokenMinor: requireInteger(limits.completionCostPerTokenMinor ?? limits.costPerTokenMinor ?? 0, "completionCostPerTokenMinor"),
      priceVersion: typeof limits.priceVersion === "string" && limits.priceVersion.trim() ? limits.priceVersion.trim().slice(0, 128) : "unpriced",
      currency: typeof limits.currency === "string" && /^[A-Z]{3}$/.test(limits.currency) ? limits.currency : "CNY",
    };
    if (this.limits.dailyTokenLimit < 1 || this.limits.perTaskTokenLimit < 1 || this.limits.costPerTokenMinor < 0) throw new BudgetError("BUDGET_CONFIG", "Budget limits are out of range");
    this.backend = backend;
    this.state = backend?.load() || load(this.filePath);
    this.rollDay();
  }

  get summary(): { day: string; dailyReserved: number; dailyUsed: number; dailyRemaining: number } {
    this.refreshFromBackend();
    this.rollDay();
    return { day: this.state.day, dailyReserved: this.state.dailyReserved, dailyUsed: this.state.dailyUsed, dailyRemaining: Math.max(0, this.limits.dailyTokenLimit - this.state.dailyReserved) };
  }

  getTask(taskId: string): LedgerTask | undefined {
    this.refreshFromBackend();
    this.rollDay();
    const task = this.state.tasks[taskId];
    return task ? clone(task) : undefined;
  }

  reserve(taskId: string, requestedTokens: number, pricing?: Pick<BudgetLimits, 'promptCostPerTokenMinor' | 'completionCostPerTokenMinor' | 'priceVersion' | 'currency'>): LedgerTask {
    this.refreshFromBackend();
    this.rollDay();
    const tokens = requirePositiveInteger(requestedTokens, "requestedTokens");
    if (tokens > this.limits.perTaskTokenLimit) throw new BudgetError("TASK_TOKEN_LIMIT", `Task reservation exceeds ${this.limits.perTaskTokenLimit} tokens`, { requestedTokens: tokens });
    const existing = this.state.tasks[taskId];
    if (existing && existing.status !== "refunded") return clone(existing); // idempotent retry
    if (this.state.dailyReserved + tokens > this.limits.dailyTokenLimit) throw new BudgetError("DAILY_TOKEN_LIMIT", "Daily token budget is exhausted", { remaining: Math.max(0, this.limits.dailyTokenLimit - this.state.dailyReserved) });
    const now = new Date().toISOString();
    const task: LedgerTask = { taskId, day: this.state.day, reservedTokens: tokens, usedTokens: 0, costMinor: 0, status: "reserved", usageKnown: false, priceVersion: pricing?.priceVersion || this.limits.priceVersion, currency: pricing?.currency || this.limits.currency, promptCostPerTokenMinor: requireInteger(pricing?.promptCostPerTokenMinor ?? this.limits.promptCostPerTokenMinor, "promptCostPerTokenMinor"), completionCostPerTokenMinor: requireInteger(pricing?.completionCostPerTokenMinor ?? this.limits.completionCostPerTokenMinor, "completionCostPerTokenMinor"), updatedAt: now };
    this.state.tasks[taskId] = task;
    this.state.dailyReserved += tokens;
    this.append({ taskId, kind: "reserve", tokens, costMinor: 0, at: now });
    this.persistSoon();
    return clone(task);
  }

  /**
   * Settle a reservation. Unknown provider usage is never estimated: the task
   * becomes `paused` and its reservation remains held until an operator retries
   * or refunds it.
   */
  reconcile(taskId: string, usage?: TokenUsage): LedgerTask {
    this.refreshFromBackend();
    this.rollDay();
    const task = this.state.tasks[taskId];
    if (!task) throw new BudgetError("TASK_NOT_RESERVED", `No reservation exists for ${taskId}`);
    if (task.status === "settled" || task.status === "refunded") return clone(task);
    if (!usage || !validUsage(usage)) {
      task.status = "paused";
      task.usageKnown = false;
      task.updatedAt = new Date().toISOString();
      this.append({ taskId, kind: "pause", tokens: 0, costMinor: 0, at: task.updatedAt });
      this.persistSoon();
      return clone(task);
    }
    const total = usage.totalTokens;
    if (total > this.limits.perTaskTokenLimit) throw new BudgetError("TASK_TOKEN_LIMIT", "Actual usage exceeds per-task limit", { total });
    if (total > task.reservedTokens) {
      const extra = total - task.reservedTokens;
      if (this.state.dailyReserved + extra > this.limits.dailyTokenLimit) {
        task.status = "paused";
        task.usageKnown = true;
        task.updatedAt = new Date().toISOString();
        this.append({ taskId, kind: "pause", tokens: extra, costMinor: 0, at: task.updatedAt });
        this.persistSoon();
        return clone(task);
      }
      this.state.dailyReserved += extra;
      task.reservedTokens = total;
    }
    // Return unused reservation to the daily pool. This makes the daily cap a
    // cap on actual/held tokens rather than an ever-increasing estimate.
    this.state.dailyReserved -= Math.max(0, task.reservedTokens - total);
    task.reservedTokens = total;
    task.usedTokens = total;
    task.promptTokens = usage.promptTokens;
    task.completionTokens = usage.completionTokens;
    task.priceVersion = task.priceVersion || this.limits.priceVersion;
    task.currency = task.currency || this.limits.currency;
    task.costMinor = safeWeightedCost(usage.promptTokens, task.promptCostPerTokenMinor ?? this.limits.promptCostPerTokenMinor, usage.completionTokens, task.completionCostPerTokenMinor ?? this.limits.completionCostPerTokenMinor);
    task.status = "settled";
    task.usageKnown = true;
    task.updatedAt = new Date().toISOString();
    this.state.dailyUsed += total;
    this.append({ taskId, kind: "settle", tokens: total, costMinor: task.costMinor, at: task.updatedAt });
    this.persistSoon();
    return clone(task);
  }

  refund(taskId: string): LedgerTask {
    this.refreshFromBackend();
    this.rollDay();
    const task = this.state.tasks[taskId];
    if (!task) throw new BudgetError("TASK_NOT_RESERVED", `No reservation exists for ${taskId}`);
    if (task.status === "refunded") return clone(task);
    if (task.status === "settled") this.state.dailyUsed = Math.max(0, this.state.dailyUsed - task.usedTokens);
    this.state.dailyReserved = Math.max(0, this.state.dailyReserved - task.reservedTokens);
    task.status = "refunded";
    task.updatedAt = new Date().toISOString();
    this.append({ taskId, kind: "refund", tokens: task.reservedTokens, costMinor: task.costMinor, at: task.updatedAt });
    this.persistSoon();
    return clone(task);
  }

  listEntries(taskId?: string): LedgerEntry[] {
    this.refreshFromBackend();
    return this.state.entries.filter((entry) => !taskId || entry.taskId === taskId).map(clone);
  }

  async flush(): Promise<void> { await this.writeChain; }

  private append(entry: Omit<LedgerEntry, "id">): void {
    this.state.entries.push({ id: randomUUID(), ...entry });
    if (this.state.entries.length > 50_000) this.state.entries.splice(0, this.state.entries.length - 50_000);
  }
  private rollDay(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.state.day === day) return;
    this.state.day = day;
    this.state.dailyReserved = 0;
    this.state.dailyUsed = 0;
    this.state.tasks = {};
    this.persistSoon();
  }
  private refreshFromBackend(): void {
    if (!this.backend) return;
    const latest = this.backend.load();
    if (latest) this.state = latest;
  }
  private persistSoon(): void {
    const payload = JSON.stringify(this.state, null, 2);
    if (this.backend) {
      this.backend.save(clone(this.state));
      return;
    }
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fsp.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temp, this.filePath);
    });
  }
}

function load(filePath: string): LedgerState {
  if (!fs.existsSync(filePath)) return { version: 1, day: new Date().toISOString().slice(0, 10), dailyReserved: 0, dailyUsed: 0, tasks: {}, entries: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LedgerState>;
    if (parsed.version !== 1) throw new Error("Unsupported budget state version");
    return { version: 1, day: parsed.day || new Date().toISOString().slice(0, 10), dailyReserved: parsed.dailyReserved || 0, dailyUsed: parsed.dailyUsed || 0, tasks: parsed.tasks || {}, entries: parsed.entries || [] };
  } catch (error) {
    throw new BudgetError("BUDGET_STATE", `Unable to load budget ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validUsage(usage: TokenUsage): boolean {
  return [usage.promptTokens, usage.completionTokens, usage.totalTokens].every((n) => Number.isSafeInteger(n) && n >= 0) && usage.promptTokens + usage.completionTokens === usage.totalTokens;
}
function requireInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new BudgetError("BUDGET_CONFIG", `${name} must be an integer`);
  return value;
}
function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BudgetError("TOKEN_INTEGER", `${name} must be a positive integer`);
  return value;
}
function safeWeightedCost(promptTokens: number, promptRate: number, completionTokens: number, completionRate: number): number {
  const cost = BigInt(promptTokens) * BigInt(promptRate) + BigInt(completionTokens) * BigInt(completionRate);
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetError("COST_OVERFLOW", "Token cost exceeds safe integer range");
  return Number(cost);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
