import { BudgetStateBackend, LedgerState } from "./ledger";
import type { SqliteLike } from "../jobs/repository";
import { acquireWriteLease, releaseWriteLease } from "../maintenance";
interface SqliteStatement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number } }

/** SQLite snapshot backend for the token ledger (duck-typed better-sqlite3). */
export class SqliteBudgetStateBackend implements BudgetStateBackend {
  private readonly readStatement: SqliteStatement;
  private revision = 0;
  constructor(private readonly db: SqliteLike) {
    if (!db || typeof db.prepare !== "function") throw new Error("A better-sqlite3 compatible database is required");
    db.exec("CREATE TABLE IF NOT EXISTS pipeline_budget_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const columns = db.prepare("PRAGMA table_info(pipeline_budget_state)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "revision")) db.exec("ALTER TABLE pipeline_budget_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    this.readStatement = db.prepare("SELECT revision, state_json FROM pipeline_budget_state WHERE id = 1");
  }
  load(): LedgerState | undefined {
    const row = this.readStatement.get() as { revision: number; state_json: string } | undefined;
    if (!row) { this.revision = 0; return undefined; }
    this.revision = Number(row.revision) || 0;
    const parsed = JSON.parse(row.state_json) as LedgerState;
    if (parsed.version !== 1) throw new Error("Unsupported budget state version");
    return parsed;
  }
  save(state: LedgerState): void {
    const expected = this.revision;
    const payload = JSON.stringify(state);
    const lease = acquireWriteLease('pipeline.budget');
    try { this.db.transaction(() => {
      const current = this.db.prepare("SELECT revision FROM pipeline_budget_state WHERE id = 1").get() as { revision: number } | undefined;
      if (!current) {
        if (expected !== 0) throw conflict();
        this.db.prepare("INSERT INTO pipeline_budget_state (id, version, revision, state_json, updated_at) VALUES (1, 1, 1, ?, datetime('now'))").run(payload);
        this.projectState(state);
        this.revision = 1;
        return;
      }
      if (Number(current.revision) !== expected) throw conflict();
      const result = this.db.prepare("UPDATE pipeline_budget_state SET version=1, revision=revision+1, state_json=?, updated_at=datetime('now') WHERE id=1 AND revision=?").run(payload, expected);
      if (result.changes !== 1) throw conflict();
      this.projectState(state);
      this.revision = expected + 1;
    })(); } finally { releaseWriteLease(lease); }
  }

  private projectState(state: LedgerState): void {
    // Project the immutable reservation/event views when the corresponding
    // migrations are present. Keep this best-effort for older databases so a
    // migration rollback cannot make the core JSON ledger unusable.
    try {
      const reservation = this.db.prepare(`INSERT INTO token_reservations
        (task_id, day, reserved_tokens, used_tokens, cost_minor, status, usage_known, prompt_tokens, completion_tokens, price_version, currency, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET day=excluded.day, reserved_tokens=excluded.reserved_tokens,
          used_tokens=excluded.used_tokens, cost_minor=excluded.cost_minor, status=excluded.status,
          usage_known=excluded.usage_known, prompt_tokens=excluded.prompt_tokens,
          completion_tokens=excluded.completion_tokens, price_version=excluded.price_version,
          currency=excluded.currency, updated_at=excluded.updated_at`);
      for (const task of Object.values(state.tasks)) reservation.run(task.taskId, task.day, task.reservedTokens, task.usedTokens, task.costMinor, task.status, task.usageKnown ? 1 : 0, task.promptTokens ?? null, task.completionTokens ?? null, task.priceVersion ?? null, task.currency ?? null, task.updatedAt);
      const event = this.db.prepare(`INSERT OR IGNORE INTO usage_ledger
        (id, task_id, kind, prompt_tokens, completion_tokens, total_tokens, cost_minor, usage_known, price_version, currency, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of state.entries) {
        const task = state.tasks[entry.taskId];
        event.run(entry.id, entry.taskId, entry.kind, task?.promptTokens ?? null, task?.completionTokens ?? null, entry.tokens, entry.costMinor, task?.usageKnown ? 1 : 0, task?.priceVersion ?? null, task?.currency ?? null, entry.at);
      }
      const legacy = this.db.prepare(`INSERT OR IGNORE INTO token_ledger (id, task_id, kind, tokens, cost_minor, at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const entry of state.entries) legacy.run(entry.id, entry.taskId, entry.kind, entry.tokens, entry.costMinor, entry.at);
    } catch (error) {
      if (!/no such table|has no column/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

function conflict(): Error & { code: string; class: string; retryable: boolean } {
  const error = new Error("Budget state changed concurrently; retry the operation") as Error & { code: string; class: string; retryable: boolean };
  error.code = "BUDGET_STATE_CONFLICT";
  error.class = "budget";
  error.retryable = true;
  return error;
}
