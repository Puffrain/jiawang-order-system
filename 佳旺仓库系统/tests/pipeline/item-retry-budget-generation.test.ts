import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipelineStore } from "../../lib/jobs/store";
import { TokenLedger } from "../../lib/budget/ledger";
import { ImportJobRunner } from "../../lib/jobs/runner";
import { AIProviderError } from "../../lib/ai/provider";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("item retry settles only usage from its new budget generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-item-budget-generation-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    const sourcePath = path.join(root, "source.png");
    await fs.writeFile(sourcePath, PNG);
    const assetBase = { sha256: "a".repeat(64), path: sourcePath, filename: "source.png", mimeType: "image/png" as const, bytes: PNG.length, createdAt: new Date().toISOString() };
    store.putAsset({ ...assetBase, id: "asset-a" });
    store.putAsset({ ...assetBase, id: "asset-b", sha256: "b".repeat(64) });
    const created = store.createJob({ itemIds: [], totalItems: 0, provider: "test", reservedTokens: 0 });
    const selected = store.createItem({ jobId: created.id, sourceAssetId: "asset-a" });
    const sibling = store.createItem({ jobId: created.id, sourceAssetId: "asset-b" });
    let calls = 0;
    const provider = {
      name: "test",
      async probe() { return { provider: "test", available: true, vision: true, acceptsDataUrl: true }; },
      async analyze() {
        calls += 1;
        const totalTokens = calls <= 2 ? 11 : 7;
        return { category: "pending", backLabel: { productName: `item-${calls}` }, usage: { promptTokens: totalTokens - 2, completionTokens: 2, totalTokens } };
      },
    };
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, { test: provider }, { derivativeRoot: root, estimatedTokensPerItem: 100 });

    await runner.run(created.id);
    const firstGeneration = `job:${created.id}`;
    assert.equal(ledger.getTask(firstGeneration)?.usedTokens, 22);
    assert.equal(store.getItem(selected.id)?.status, "needs_review");
    assert.equal(store.getItem(sibling.id)?.status, "needs_review");

    // Return only the selected item for retry. Keep the sibling's first-run
    // usage in its snapshot; a new item-scoped generation must not charge it.
    store.transitionItem(selected.id, "failed", { error: { code: "RETRYABLE", message: "retry", class: "io", retryable: true } });
    store.putJob({ ...store.getJob(created.id)!, status: "failed" });
    const retried = runner.retryItem(created.id, selected.id);
    const secondGeneration = retried.budgetTaskId!;
    assert.match(secondGeneration, new RegExp(`^job:${created.id}:item:${selected.id}:retry:1$`));

    const finished = await runner.run(created.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(ledger.getTask(secondGeneration)?.usedTokens, 7);
    assert.equal(ledger.getTask(firstGeneration)?.usedTokens, 22);
    assert.equal(store.getItem(selected.id)?.status, "needs_review");
    assert.equal(store.getItem(sibling.id)?.status, "needs_review");
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a provider failure in a retry generation does not settle prior usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-item-budget-failure-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    const sourcePath = path.join(root, "source.png");
    await fs.writeFile(sourcePath, PNG);
    const asset = { id: "asset-one", sha256: "c".repeat(64), path: sourcePath, filename: "source.png", mimeType: "image/png" as const, bytes: PNG.length, createdAt: new Date().toISOString() };
    store.putAsset(asset);
    const created = store.createJob({ itemIds: [], totalItems: 0, provider: "test", reservedTokens: 0 });
    const item = store.createItem({ jobId: created.id, sourceAssetId: asset.id });
    let calls = 0;
    const provider = {
      name: "test",
      async probe() { return { provider: "test", available: true, vision: true, acceptsDataUrl: true }; },
      async analyze() {
        calls += 1;
        if (calls > 1) throw new AIProviderError("HTTP_500", "provider failed", false);
        return { category: "pending", backLabel: { productName: "item" }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      },
    };
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, { test: provider }, { derivativeRoot: root, estimatedTokensPerItem: 100 });
    await runner.run(created.id);
    const firstGeneration = `job:${created.id}`;
    assert.equal(ledger.getTask(firstGeneration)?.usedTokens, 15);
    store.putItem({ ...store.getItem(item.id)!, error: { code: "REVIEW_NEEDS_CHANGES", message: "retry", class: "validation", retryable: false } });
    const retried = runner.retryItem(created.id, item.id);
    const secondGeneration = retried.budgetTaskId!;
    const finished = await runner.run(created.id);
    assert.equal(finished.status, "paused");
    assert.equal(ledger.getTask(firstGeneration)?.usedTokens, 15);
    assert.equal(ledger.getTask(secondGeneration)?.status, "paused");
    assert.equal(ledger.getTask(secondGeneration)?.usedTokens, 0);
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("item retry replay is idempotent and a different item conflicts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-item-retry-idempotence-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});
    const job = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const first = store.createItem({ jobId: job.id, sourceAssetId: "asset-one" });
    const second = store.createItem({ jobId: job.id, sourceAssetId: "asset-two" });
    store.transitionItem(first.id, "failed", { error: { code: "FAILED", message: "failed", class: "io", retryable: true } });
    store.transitionItem(second.id, "failed", { error: { code: "FAILED", message: "failed", class: "io", retryable: true } });
    store.transitionJob(job.id, "failed");
    const queued = runner.retryItem(job.id, first.id);
    const replay = runner.retryItem(job.id, first.id);
    assert.equal(replay.budgetTaskId, queued.budgetTaskId);
    assert.equal(replay.retryCount, queued.retryCount);
    assert.throws(() => runner.retryItem(job.id, second.id), /already queued|conflict/i);
    assert.equal(store.getItem(second.id)?.status, "failed");
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("whole-job retry preserves review-deleted items and retries other failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jw-job-retry-review-rejected-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(root, "state.json"));
    ledger = new TokenLedger(path.join(root, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 2_000 });
    const runner = new ImportJobRunner(store, ledger, {});
    const job = store.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    const deleted = store.createItem({ jobId: job.id, sourceAssetId: "asset-deleted" });
    const retryable = store.createItem({ jobId: job.id, sourceAssetId: "asset-retryable" });
    store.transitionItem(deleted.id, "failed", { error: { code: "REVIEW_REJECTED", message: "deleted by reviewer", class: "validation", retryable: false } });
    store.transitionItem(retryable.id, "failed", { error: { code: "PROVIDER_FAILURE", message: "retry", class: "provider", retryable: true } });
    store.transitionJob(job.id, "failed");

    const retried = runner.retry(job.id);
    assert.equal(retried.status, "queued");
    assert.equal(store.getItem(retryable.id)?.status, "queued");
    assert.equal(store.getItem(deleted.id)?.status, "failed");
    assert.equal(store.getItem(deleted.id)?.error?.code, "REVIEW_REJECTED");
  } finally {
    await store?.flush().catch(() => undefined);
    await ledger?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
