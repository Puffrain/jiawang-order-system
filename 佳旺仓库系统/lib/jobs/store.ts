import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  EMPTY_PIPELINE_STATE,
  ImportItem,
  ImportJob,
  GroupRecord,
  Lease,
  PipelineEvent,
  PipelineError,
  PipelineStoreState,
  UploadSession,
  AssetRecord,
  JobStatus,
  ItemStatus,
} from "../contracts/pipeline";
import { PipelineStateBackend } from "./repository";

/**
 * A tiny durable store used by the worker and by development deployments.
 * Production deployments can mirror these operations onto SQLite; keeping a
 * file-backed implementation here makes restart/recovery semantics testable
 * without requiring a database connection in a worker process.
 */
export class PipelineStore {
  readonly filePath: string;
  private state: PipelineStoreState;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly backend?: PipelineStateBackend;

  constructor(filePath = defaultStatePath(), backend?: PipelineStateBackend) {
    this.filePath = path.resolve(filePath);
    this.backend = backend;
    this.state = backend?.load() || loadState(this.filePath);
  }

  get snapshot(): PipelineStoreState {
    this.refreshFromBackend();
    return clone(this.state);
  }

  getUpload(id: string): UploadSession | undefined {
    this.refreshFromBackend();
    return clone(this.state.uploads[id]);
  }
  getAsset(id: string): AssetRecord | undefined {
    this.refreshFromBackend();
    return clone(this.state.assets[id]);
  }
  /** Find an immutable asset by digest for cross-upload de-duplication. */
  findAssetBySha256(sha256: string): AssetRecord | undefined {
    this.refreshFromBackend();
    if (!/^[0-9a-f]{64}$/i.test(sha256)) return undefined;
    const found = Object.values(this.state.assets).find((asset) => asset.sha256.toLowerCase() === sha256.toLowerCase());
    return clone(found);
  }
  getJob(id: string): ImportJob | undefined {
    this.refreshFromBackend();
    return clone(this.state.jobs[id]);
  }
  listJobs(limit = 100): ImportJob[] {
    this.refreshFromBackend();
    const bounded = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 100, 500));
    return Object.values(this.state.jobs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded)
      .map(clone);
  }

  /** Check every durable job for a live lease without the UI-oriented 500-row
   * pagination cap.  Backup/restore maintenance must drain the whole queue;
   * looking only at the first page could leave job 501 writing media while a
   * database generation is being switched. */
  hasActiveLeases(now = Date.now()): boolean {
    this.refreshFromBackend();
    return Object.values(this.state.jobs).some((job) => Boolean(job.lease && Date.parse(job.lease.expiresAt) > now));
  }
  getItem(id: string): ImportItem | undefined {
    this.refreshFromBackend();
    return clone(this.state.items[id]);
  }
  listItems(jobId: string): ImportItem[] {
    this.refreshFromBackend();
    return Object.values(this.state.items)
      .filter((item) => item.jobId === jobId)
      .map(clone);
  }
  listGroups(): GroupRecord[] { this.refreshFromBackend(); return Object.values(this.state.groups).map(clone); }
  listReviewItems(jobId?: string): ImportItem[] {
    this.refreshFromBackend();
    return Object.values(this.state.items).filter((item) => item.status === "needs_review" && (!jobId || item.jobId === jobId)).map(clone);
  }
  listEvents(jobId: string, afterId = 0): PipelineEvent[] {
    this.refreshFromBackend();
    return this.state.events.filter((event) => event.jobId === jobId && event.id > afterId).map(clone);
  }

  createUpload(input: Omit<UploadSession, "id" | "createdAt" | "updatedAt" | "receivedChunks" | "receivedBytes" | "status"> & Partial<Pick<UploadSession, "status">>): UploadSession {
    this.refreshFromBackend();
    const now = new Date().toISOString();
    const upload: UploadSession = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      receivedChunks: [],
      receivedBytes: 0,
      status: input.status || "created",
    };
    this.state.uploads[upload.id] = upload;
    this.persistSoon();
    return clone(upload);
  }

  putUpload(upload: UploadSession): UploadSession {
    this.refreshFromBackend();
    const existing = this.state.uploads[upload.id];
    if (existing?.status === "completed" && (existing.originalAssetId !== upload.originalAssetId || existing.sha256 !== upload.sha256 || existing.originalPath !== upload.originalPath)) {
      throw pipelineStoreError("UPLOAD_IMMUTABLE", "Completed upload source identity cannot be changed");
    }
    this.state.uploads[upload.id] = { ...clone(upload), updatedAt: new Date().toISOString() };
    this.persistSoon();
    return clone(this.state.uploads[upload.id]);
  }

  putAsset(asset: AssetRecord): AssetRecord {
    this.refreshFromBackend();
    // Original bytes are globally content-addressed. Repeated uploads retain
    // their own upload/source relationship while reusing the first immutable
    // media record. Derivatives keep their own identity because a preview can
    // have different access semantics even when its bytes happen to match.
    if (!asset.derivativeKind) {
      const byDigest = Object.values(this.state.assets).find((candidate) => !candidate.derivativeKind && candidate.sha256.toLowerCase() === asset.sha256.toLowerCase());
      if (byDigest && byDigest.id !== asset.id) return clone(byDigest);
    }
    // An asset id/digest is immutable.  Replacing a record with different
    // bytes would make an existing job point at mutable source data.
    const existing = this.state.assets[asset.id];
    if (existing && (existing.sha256 !== asset.sha256 || existing.path !== asset.path || existing.bytes !== asset.bytes)) {
      throw pipelineStoreError("ASSET_IMMUTABLE", "An asset record cannot be changed once persisted");
    }
    this.state.assets[asset.id] = clone(asset);
    this.persistSoon();
    return clone(asset);
  }

  createJob(input: Omit<ImportJob, "id" | "createdAt" | "updatedAt" | "cancelRequested" | "completedItems" | "failedItems" | "status" | "stage"> & Partial<Pick<ImportJob, "status" | "stage" | "completedItems" | "failedItems" | "cancelRequested">>): ImportJob {
    this.refreshFromBackend();
    const now = new Date().toISOString();
    const job: ImportJob = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: input.status || "queued",
      stage: input.stage || "queued",
      completedItems: input.completedItems || 0,
      failedItems: input.failedItems || 0,
      cancelRequested: Boolean(input.cancelRequested),
    };
    this.state.jobs[job.id] = job;
    this.event(job.id, "job.created", { status: job.status, totalItems: job.totalItems }, false);
    this.persistSoon();
    return clone(job);
  }

  putJob(job: ImportJob): ImportJob {
    this.refreshFromBackend();
    if (!this.state.jobs[job.id]) throw pipelineStoreError("JOB_NOT_FOUND", `Unknown job ${job.id}`);
    this.state.jobs[job.id] = { ...clone(job), updatedAt: new Date().toISOString() };
    this.persistSoon();
    return clone(this.state.jobs[job.id]);
  }

  createItem(input: Omit<ImportItem, "id" | "updatedAt" | "attempts" | "status" | "manualRequired"> & Partial<Pick<ImportItem, "status" | "attempts" | "manualRequired">>): ImportItem {
    this.refreshFromBackend();
    const item: ImportItem = {
      ...input,
      id: randomUUID(),
      updatedAt: new Date().toISOString(),
      attempts: input.attempts || 0,
      status: input.status || "queued",
      manualRequired: Boolean(input.manualRequired),
    };
    if (!this.state.jobs[item.jobId]) throw pipelineStoreError("JOB_NOT_FOUND", `Unknown job ${item.jobId}`);
    this.state.items[item.id] = item;
    const job = this.state.jobs[item.jobId];
    if (!job.itemIds.includes(item.id)) {
      job.itemIds.push(item.id);
      job.totalItems = job.itemIds.length;
      job.updatedAt = new Date().toISOString();
    }
    this.persistSoon();
    return clone(item);
  }

  putItem(item: ImportItem): ImportItem {
    this.refreshFromBackend();
    if (!this.state.items[item.id]) throw pipelineStoreError("ITEM_NOT_FOUND", `Unknown item ${item.id}`);
    this.state.items[item.id] = { ...clone(item), updatedAt: new Date().toISOString() };
    this.persistSoon();
    return clone(this.state.items[item.id]);
  }

  transitionJob(id: string, status: JobStatus, error?: PipelineError): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (TERMINAL_JOB.has(job.status) && job.status !== status) return clone(job);
    job.status = status;
    if (status === "failed") job.stage = "failed";
    if (status === "succeeded" && job.stage !== "review_pending") job.stage = "completed";
    if (error) job.error = clone(error);
    job.updatedAt = new Date().toISOString();
    const eventType = status === "running" ? "job.started" : status === "paused" ? "job.paused" : status === "cancelled" ? "job.cancelled" : status === "succeeded" ? "job.completed" : status === "failed" ? "job.failed" : "job.progress";
    this.event(id, eventType, { status, ...(error ? { error } : {}) }, false);
    this.persistSoon();
    return clone(job);
  }

  transitionItem(id: string, status: ItemStatus, patch: Partial<ImportItem> = {}): ImportItem {
    this.refreshFromBackend();
    const item = this.requireItem(id);
    const previous = item.status;
    if (TERMINAL_ITEM.has(previous) && previous !== status) return clone(item);
    Object.assign(item, patch, { status, updatedAt: new Date().toISOString() });
    const job = this.state.jobs[item.jobId];
    if ((status === "succeeded" || status === "needs_review") && previous !== "succeeded" && previous !== "needs_review") job.completedItems += 1;
    if (status === "failed" && previous !== "failed") job.failedItems += 1;
    this.event(item.jobId, "item.updated", { itemId: item.id, status, ...(patch.error ? { error: patch.error } : {}) }, false);
    this.persistSoon();
    return clone(item);
  }

  /** Atomically claim a job lease, reclaiming only expired leases. */
  acquireJobLease(id: string, owner: string, ttlMs = 60_000, now = Date.now()): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (TERMINAL_JOB.has(job.status)) {
      throw pipelineStoreError("JOB_PAUSE_STATE", "当前任务已结束，不能暂停", false);
    }
    if (job.lease && Date.parse(job.lease.expiresAt) > now && job.lease.owner !== owner) {
      throw pipelineStoreError("LEASE_BUSY", "Job is leased by another worker", true);
    }
    const lease = makeLease(owner, ttlMs, now);
    job.lease = lease;
    if (job.status === "queued" || job.status === "paused") job.status = "running";
    job.updatedAt = new Date(now).toISOString();
    this.event(id, "job.started", { owner, expiresAt: lease.expiresAt }, false);
    this.persistSoon();
    return clone(job);
  }

  renewJobLease(id: string, owner: string, ttlMs = 60_000, now = Date.now()): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (!job.lease || job.lease.owner !== owner || Date.parse(job.lease.expiresAt) <= now) throw pipelineStoreError("LEASE_LOST", "Job lease is missing or expired", true);
    job.lease = makeLease(owner, ttlMs, now, job.lease.acquiredAt);
    job.updatedAt = new Date(now).toISOString();
    this.persistSoon();
    return clone(job);
  }

  releaseJobLease(id: string, owner: string): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (job.lease?.owner === owner) {
      delete job.lease;
      job.updatedAt = new Date().toISOString();
      this.persistSoon();
    }
    return clone(job);
  }

  acquireItemLease(id: string, owner: string, ttlMs = 60_000, now = Date.now()): ImportItem {
    this.refreshFromBackend();
    const item = this.requireItem(id);
    if (TERMINAL_ITEM.has(item.status)) return clone(item);
    if (item.lease && Date.parse(item.lease.expiresAt) > now && item.lease.owner !== owner) throw pipelineStoreError("LEASE_BUSY", "Item is leased by another worker", true);
    item.lease = makeLease(owner, ttlMs, now);
    item.status = "running";
    item.attempts += 1;
    item.updatedAt = new Date(now).toISOString();
    this.persistSoon();
    return clone(item);
  }

  requestCancel(id: string): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    // Cancellation is deliberately idempotent: repeating the request returns
    // the same terminal/cancelling state and never creates duplicate events.
    if (job.status === "cancelled" || job.status === "succeeded" || job.status === "failed") return clone(job);
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      job.status = "cancelling";
      job.updatedAt = new Date().toISOString();
      this.event(id, "job.progress", { status: "cancelling" }, false);
      for (const itemId of job.itemIds) {
        const item = this.state.items[itemId];
        if (item && !TERMINAL_ITEM.has(item.status)) {
          item.status = "cancelled";
          item.error = { code: "CANCELLED", message: "Job cancellation requested", class: "cancelled", retryable: false };
          item.updatedAt = new Date().toISOString();
          this.event(id, "item.updated", { itemId, status: "cancelled" }, false);
        }
      }
      this.persistSoon();
    }
    return clone(job);
  }

  /** Explicit operator pause. This is a durable checkpoint and deliberately
   * does not set cancelRequested or alter item data. A worker that is between
   * item calls observes the paused status and releases its lease before the
   * next provider request. Repeating the operation is idempotent. */
  pauseJob(id: string, reason = "任务由操作员暂停"): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (TERMINAL_JOB.has(job.status)) throw pipelineStoreError("JOB_PAUSE_STATE", "Terminal jobs cannot be paused");
    if (job.status === "paused" && job.error?.code === "PAUSED_MANUAL") return clone(job);
    if (!["queued", "running"].includes(job.status)) {
      throw pipelineStoreError("JOB_PAUSE_STATE", "当前任务状态不允许暂停");
    }
    job.status = "paused";
    job.error = { code: "PAUSED_MANUAL", message: reason.slice(0, 500), class: "validation", retryable: true };
    job.updatedAt = new Date().toISOString();
    this.event(id, "job.paused", { status: "paused", reason: job.error.message }, false);
    this.persistSoon();
    return clone(job);
  }

  /** Move a paused checkpoint back to the durable queue. The runner will
   * reacquire a lease on the next worker poll. The pause explanation is
   * cleared so a later provider/budget error is not mistaken for a manual
   * checkpoint. */
  resumeJob(id: string): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    if (job.status !== "paused") {
      if (["queued", "running"].includes(job.status)) return clone(job);
      throw pipelineStoreError("JOB_RESUME_STATE", "只有已暂停任务可以恢复");
    }
    job.status = "queued";
    job.error = undefined;
    job.cancelRequested = false;
    job.updatedAt = new Date().toISOString();
    this.event(id, "job.progress", { status: "queued", resumed: true }, false);
    this.persistSoon();
    return clone(job);
  }

  /** Requeue failed/cancelled work without touching successful or reviewable
   * items. Candidate/product revisions remain intact; AI retries only write a
   * new suggestion/evidence revision through the normal runner path. */
  retryJob(id: string, canRetryItem?: (item: ImportItem) => boolean, nextBudgetTaskId?: string, pendingRefundTaskId?: string): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(id);
    // A client may retry a timed-out control request. Once this job has
    // already entered a retry generation, returning its current queued/running
    // state is idempotent; a later failed state still creates the next
    // generation normally.
    if ((job.status === "queued" || job.status === "running") && (job.retryCount || 0) > 0 && isWholeJobRetryTask(job.budgetTaskId)) {
      return clone(job);
    }
    if (!["failed", "cancelled"].includes(job.status)) {
      throw pipelineStoreError("JOB_RETRY_STATE", "只有失败或已取消任务可以重试");
    }
    const itemIds = new Set(job.itemIds);
    for (const item of Object.values(this.state.items)) {
      if (item.jobId !== id || !itemIds.has(item.id)) continue;
      if (item.error?.code === "REVIEW_REJECTED") continue;
      if (!["succeeded", "needs_review"].includes(item.status) && item.candidateProductId && canRetryItem && !canRetryItem(item)) {
        throw pipelineStoreError("JOB_RETRY_PUBLISHED", "任务包含已批准/已发布商品，不能自动重试");
      }
    }
    for (const item of Object.values(this.state.items)) {
      if (item.jobId !== id || !itemIds.has(item.id)) continue;
      if (item.error?.code === "REVIEW_REJECTED") continue;
      if (["succeeded", "needs_review"].includes(item.status)) continue;
      item.status = "queued";
      delete item.lease;
      item.error = undefined;
      item.manualRequired = false;
      item.aiRaw = { ...(item.aiRaw || {}), __rerunRequested: true, __rerunTaskId: nextBudgetTaskId || job.budgetTaskId || `job:${id}` };
      item.updatedAt = new Date().toISOString();
    }
    recountJob(job, this.state.items);
    job.status = "queued";
    job.stage = job.totalItems === 0 ? "queued" : job.stage === "failed" ? "preprocessing" : job.stage;
    job.cancelRequested = false;
    job.error = undefined;
    job.lease = undefined;
    if (nextBudgetTaskId) {
      job.budgetTaskId = nextBudgetTaskId;
      job.retryCount = (job.retryCount || 0) + 1;
      job.reservedTokens = 0;
      job.usedTokens = undefined;
      job.estimatedCostMinor = 0;
    }
    if (pendingRefundTaskId) job.pendingBudgetRefund = pendingRefundTaskId;
    job.updatedAt = new Date().toISOString();
    this.event(id, "job.progress", { status: "queued", retried: true }, false);
    this.persistSoon();
    return clone(job);
  }

  /** Queue one failed/cancelled item (or a needs-review item explicitly
   * returned for changes) without resetting the rest of the import. The
   * caller validates the linked catalog product before invoking this method. */
  retryItem(jobId: string, itemId: string, nextBudgetTaskId?: string, pendingRefundTaskId?: string): ImportJob {
    this.refreshFromBackend();
    const job = this.requireJob(jobId);
    const item = this.requireItem(itemId);
    if (item.jobId !== jobId) throw pipelineStoreError("ITEM_JOB_MISMATCH", "Item does not belong to this job");
    const activeItemId = itemIdFromRetryTask(job.budgetTaskId);
    if ((job.status === "queued" || job.status === "running") && activeItemId) {
      if (activeItemId === itemId) return clone(job);
      throw pipelineStoreError("ITEM_RETRY_CONFLICT", "Another item retry is already queued for this job");
    }
    if (job.status === "running" && job.lease && Date.parse(job.lease.expiresAt) > Date.now()) {
      throw pipelineStoreError("JOB_RETRY_CONFLICT", "A worker is actively processing this job");
    }
    if (!["failed", "cancelled", "needs_review"].includes(item.status)) {
      throw pipelineStoreError("ITEM_RETRY_STATE", "当前图片条目状态不允许重试");
    }
    item.status = "queued";
    delete item.lease;
    item.error = undefined;
    item.manualRequired = false;
    item.aiRaw = { ...(item.aiRaw || {}), __rerunRequested: true, __rerunTaskId: nextBudgetTaskId || job.budgetTaskId || `job:${jobId}` };
    item.updatedAt = new Date().toISOString();
    job.status = "queued";
    job.cancelRequested = false;
    job.error = undefined;
    job.lease = undefined;
    if (nextBudgetTaskId) {
      job.budgetTaskId = nextBudgetTaskId;
      job.retryCount = (job.retryCount || 0) + 1;
      job.reservedTokens = 0;
      job.usedTokens = undefined;
      job.estimatedCostMinor = 0;
    }
    if (pendingRefundTaskId) job.pendingBudgetRefund = pendingRefundTaskId;
    if (job.stage === "failed" || job.stage === "review_pending") job.stage = "extracting";
    recountJob(job, this.state.items);
    this.event(jobId, "item.updated", { itemId, status: "queued", retried: true }, false);
    this.event(jobId, "job.progress", { status: "queued", retriedItemId: itemId }, false);
    this.persistSoon();
    return clone(job);
  }

  /** Requeue work abandoned by a crashed worker. */
  recoverExpiredLeases(now = Date.now()): { jobs: string[]; items: string[] } {
    this.refreshFromBackend();
    const jobs: string[] = [];
    const items: string[] = [];
    for (const job of Object.values(this.state.jobs)) {
      if (job.lease && Date.parse(job.lease.expiresAt) <= now) {
        delete job.lease;
        if (job.status === "running") job.status = job.cancelRequested ? "cancelling" : "queued";
        job.updatedAt = new Date(now).toISOString();
        jobs.push(job.id);
      }
    }
    for (const item of Object.values(this.state.items)) {
      if (item.lease && Date.parse(item.lease.expiresAt) <= now) {
        delete item.lease;
        if (item.status === "running") item.status = "queued";
        item.updatedAt = new Date(now).toISOString();
        items.push(item.id);
      }
    }
    if (jobs.length || items.length) this.persistSoon();
    return { jobs, items };
  }

  addGroup(name: string, itemIds: string[], category?: string): GroupRecord {
    this.refreshFromBackend();
    const now = new Date().toISOString();
    const group: GroupRecord = { id: randomUUID(), name: name.trim(), category, itemIds: [...new Set(itemIds)], createdAt: now, updatedAt: now };
    this.state.groups[group.id] = group;
    this.persistSoon();
    return clone(group);
  }

  event(jobId: string, type: PipelineEvent["type"], data: Record<string, unknown>, refresh = true): PipelineEvent {
    if (refresh) this.refreshFromBackend();
    const event: PipelineEvent = { id: this.state.nextEventId++, jobId, type, at: new Date().toISOString(), data: clone(data) };
    this.state.events.push(event);
    // Keep a bounded event log in a long-lived process; clients can still
    // consume all events for the active job in normal operation.
    if (this.state.events.length > 20_000) this.state.events.splice(0, this.state.events.length - 20_000);
    this.persistSoon();
    return clone(event);
  }

  /** Flush queued persistence writes; useful before process shutdown/tests. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private requireJob(id: string): ImportJob {
    const job = this.state.jobs[id];
    if (!job) throw pipelineStoreError("JOB_NOT_FOUND", `Unknown job ${id}`);
    return job;
  }
  private refreshFromBackend(): void {
    if (!this.backend) return;
    const latest = this.backend.load();
    if (latest) this.state = latest;
  }
  private requireItem(id: string): ImportItem {
    const item = this.state.items[id];
    if (!item) throw pipelineStoreError("ITEM_NOT_FOUND", `Unknown item ${id}`);
    return item;
  }
  protected persistSoon(): void {
    const payload = JSON.stringify(this.state, null, 2);
    if (this.backend) {
      // better-sqlite3 writes synchronously and wraps the operation in its own
      // transaction. Keep the same API while avoiding a filesystem snapshot.
      this.backend.save(clone(this.state));
      return;
    }
    const dir = path.dirname(this.filePath);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await fsp.mkdir(dir, { recursive: true });
        const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        await fsp.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
        await fsp.rename(temp, this.filePath);
      });
  }
}

export function defaultStatePath(): string {
  return process.env.PIPELINE_STATE_FILE || path.join(process.cwd(), "data", "pipeline-state.json");
}

export function makeLease(owner: string, ttlMs: number, now = Date.now(), acquiredAt?: string): Lease {
  const bounded = Math.max(1_000, Math.min(ttlMs, 24 * 60 * 60 * 1_000));
  return {
    owner,
    acquiredAt: acquiredAt || new Date(now).toISOString(),
    expiresAt: new Date(now + bounded).toISOString(),
  };
}

function isWholeJobRetryTask(taskId: string | undefined): boolean {
  return typeof taskId === "string" && /^job:[^:]+:retry:\d+$/.test(taskId);
}

function itemIdFromRetryTask(taskId: string | undefined): string | undefined {
  if (typeof taskId !== "string") return undefined;
  const match = /^job:[^:]+:item:([^:]+):retry:\d+$/.exec(taskId);
  return match?.[1];
}

export function pipelineStoreError(code: string, message: string, retryable = false): PipelineError & Error {
  const error = new Error(message) as PipelineError & Error;
  error.name = code;
  error.code = code;
  error.class = code.startsWith("LEASE") ? "io" : "validation";
  error.retryable = retryable;
  const status = domainErrorStatus(code);
  if (status !== undefined) (error as Error & { status?: number }).status = status;
  return error;
}

function domainErrorStatus(code: string): number | undefined {
  if (/(?:^|_)NOT_FOUND$/.test(code)) return 404;
  if (/(?:_STATE|_CONFLICT|_BUSY|_PUBLISHED|_IMMUTABLE|RECONCILIATION_REQUIRED)$/.test(code)) return 409;
  if (code.startsWith("LEASE")) return 409;
  return undefined;
}

const TERMINAL_JOB = new Set<JobStatus>(["cancelled", "succeeded", "failed"]);
const TERMINAL_ITEM = new Set<ItemStatus>(["cancelled", "succeeded", "failed"]);

function recountJob(job: ImportJob, items: Record<string, ImportItem>): void {
  const belonging = job.itemIds.map((itemId) => items[itemId]).filter(Boolean);
  job.totalItems = belonging.length;
  job.completedItems = belonging.filter((item) => item.status === "succeeded" || item.status === "needs_review").length;
  job.failedItems = belonging.filter((item) => item.status === "failed").length;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function loadState(filePath: string): PipelineStoreState {
  try {
    if (!fs.existsSync(filePath)) return clone(EMPTY_PIPELINE_STATE);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PipelineStoreState>;
    if (parsed.version !== 1) throw new Error("Unsupported pipeline state version");
    const jobs = parsed.jobs || {};
    for (const job of Object.values(jobs)) if (!(job as ImportJob).stage) (job as ImportJob).stage = "queued";
    return {
      version: 1,
      uploads: parsed.uploads || {},
      assets: parsed.assets || {},
      jobs,
      items: parsed.items || {},
      groups: parsed.groups || {},
      events: parsed.events || [],
      nextEventId: parsed.nextEventId || 1,
    };
  } catch (error) {
    throw new Error(`Unable to load pipeline state at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
