import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipelineStore } from "../../lib/jobs/store";
import { TokenLedger } from "../../lib/budget/ledger";
import { ImportJobRunner } from "../../lib/jobs/runner";

test("manual pause/resume is durable and blocks a stale direct run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-controls-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, { mock: { name: "mock", probe: async () => ({ provider: "mock", available: true, vision: true, acceptsDataUrl: true }), analyze: async () => ({}) } });
    const created = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const paused = runner.pause(created.id, "operator checkpoint");
    assert.equal(paused.status, "paused");
    assert.equal(paused.error?.code, "PAUSED_MANUAL");
    await assert.rejects(() => runner.run(created.id), /先恢复|paused/i);
    const resumed = runner.resume(created.id);
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.error, undefined);
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); }
});

test("terminal jobs reject pause as a state conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-pause-terminal-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});
    const job = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    store.transitionJob(job.id, "succeeded");
    assert.throws(() => runner.pause(job.id), (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "JOB_PAUSE_STATE" && (error as { status?: number }).status === 409));
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retry requeues failed/cancelled items but preserves reviewable work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-retry-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});
    const job = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const failed = store.createItem({ jobId: job.id, sourceAssetId: "asset-a" });
    const review = store.createItem({ jobId: job.id, sourceAssetId: "asset-b" });
    store.transitionItem(failed.id, "failed", { error: { code: "X", message: "x", class: "io", retryable: true } });
    store.transitionItem(review.id, "needs_review", { manualRequired: true });
    store.transitionJob(job.id, "failed");
    const retried = runner.retry(job.id);
    assert.equal(retried.status, "queued");
    assert.equal(store.getItem(failed.id)?.status, "queued");
    assert.equal(store.getItem(review.id)?.status, "needs_review");
    assert.equal(retried.failedItems, 0);
    assert.equal(retried.completedItems, 1);
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); }
});

test("retry uses a fresh budget generation and refuses unknown billing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-retry-budget-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});

    const settledJob = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const oldTask = `job:${settledJob.id}`;
    ledger.reserve(oldTask, 100);
    ledger.reconcile(oldTask, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    store.transitionJob(settledJob.id, "failed");
    const retried = runner.retry(settledJob.id);
    assert.equal(retried.budgetTaskId, `job:${settledJob.id}:retry:1`);
    assert.equal(ledger.getTask(oldTask)?.status, "settled");
    assert.equal(ledger.getTask(retried.budgetTaskId!)?.status, undefined);
    const replayed = runner.retry(settledJob.id);
    assert.equal(replayed.budgetTaskId, retried.budgetTaskId);
    assert.equal(replayed.retryCount, retried.retryCount);

    const unknownJob = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const item = store.createItem({ jobId: unknownJob.id, sourceAssetId: "asset-unknown" });
    const unknownTask = `job:${unknownJob.id}`;
    ledger.reserve(unknownTask, 100);
    store.putItem({ ...item, aiRaw: { __providerAttempted: true } });
    store.transitionItem(item.id, "failed", { error: { code: "TIMEOUT", message: "timeout", class: "provider", retryable: false } });
    store.transitionJob(unknownJob.id, "failed");
    assert.throws(() => runner.retry(unknownJob.id), /核对|重试/i);
    assert.equal(ledger.getTask(unknownTask)?.status, "reserved");

    const invalidJob = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const invalidTask = `job:${invalidJob.id}`;
    ledger.reserve(invalidTask, 100);
    assert.throws(() => runner.retry(invalidJob.id), /失败或已取消/i);
    assert.equal(ledger.getTask(invalidTask)?.status, "reserved");
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retry persists a refund marker before the ledger side effect and replays it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-retry-refund-outbox-"));
  let store: PipelineStore | undefined;
  class FlakyRefundLedger extends TokenLedger {
    failRefund = true;
    override refund(taskId: string) {
      if (this.failRefund) { this.failRefund = false; throw new Error("injected refund outage"); }
      return super.refund(taskId);
    }
  }
  let ledger: FlakyRefundLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new FlakyRefundLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});
    const job = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const taskId = `job:${job.id}`;
    ledger.reserve(taskId, 100);
    store.transitionJob(job.id, "failed");
    assert.throws(() => runner.retry(job.id), /injected refund outage/);
    const durable = store.getJob(job.id)!;
    assert.equal(durable.status, "queued");
    assert.equal(durable.pendingBudgetRefund, taskId);
    assert.equal(ledger.getTask(taskId)?.status, "reserved");
    const replay = runner.retry(job.id);
    assert.equal(replay.pendingBudgetRefund, undefined);
    assert.equal(ledger.getTask(taskId)?.status, "refunded");
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
