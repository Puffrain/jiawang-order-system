import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { PipelineStore } from "../../lib/jobs/store";
import { TokenLedger } from "../../lib/budget/ledger";
import { MockVisionProvider, DeepSeekVisionProvider } from "../../lib/ai/provider";
import { ChunkedUploadService } from "../../lib/ingest/chunked-upload";
import { ImportJobRunner } from "../../lib/jobs/runner";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("leases recover after expiry and cancellation is idempotent", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-job-"));
  let store: PipelineStore | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const job = store!.createJob({ itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    store!.acquireJobLease(job.id, "worker-a", 1_000, 1_000);
    assert.throws(() => store!.acquireJobLease(job.id, "worker-b", 1_000, 1_500), /another worker/i);
    const recovered = store!.recoverExpiredLeases(2_001);
    assert.deepEqual(recovered.jobs, [job.id]);
    store!.acquireJobLease(job.id, "worker-b", 1_000, 2_001);
    const first = store!.requestCancel(job.id);
    const second = store!.requestCancel(job.id);
    assert.equal(first.status, "cancelling");
    assert.equal(second.status, "cancelling");
  } finally { await store?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

test("integer budget reservations cap task/day and unknown usage pauses", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-budget-"));
  try {
    const file = path.join(temp, "ledger.json");
    const ledger = new TokenLedger(file, { dailyTokenLimit: 1_000, perTaskTokenLimit: 600, costPerTokenMinor: 2 });
    assert.throws(() => ledger.reserve("float", 1.5), /integer/i);
    ledger.reserve("one", 600);
    assert.throws(() => ledger.reserve("two", 500), /Daily token/i);
    assert.equal(ledger.reconcile("one").status, "paused");
    const settled = ledger.reconcile("one", { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    assert.equal(settled.status, "settled");
    assert.equal(settled.costMinor, 300);
    await ledger.flush();
    assert.equal(new TokenLedger(file, { dailyTokenLimit: 1_000, perTaskTokenLimit: 600 }).getTask("one")?.usedTokens, 150);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("task pricing snapshot remains immutable across ledger restart", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-pricing-snapshot-"));
  try {
    const file = path.join(temp, "ledger.json");
    const first = new TokenLedger(file, { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000, promptCostPerTokenMinor: 99, completionCostPerTokenMinor: 99, priceVersion: "runtime-new" });
    first.reserve("job:a", 500, { promptCostPerTokenMinor: 2, completionCostPerTokenMinor: 5, priceVersion: "profile-v1", currency: "USD" });
    await first.flush();
    const restarted = new TokenLedger(file, { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000, promptCostPerTokenMinor: 77, completionCostPerTokenMinor: 77, priceVersion: "runtime-newer" });
    const settled = restarted.reconcile("job:a", { promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    assert.equal(settled.costMinor, 300);
    assert.equal(settled.priceVersion, "profile-v1");
    assert.equal(settled.currency, "USD");
    await restarted.flush();
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("unavailable provider moves queued items into manual review", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-provider-manual-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const uploads = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1_024, maxUploadBytes: 2_048 });
    const upload = await uploads.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await uploads.putChunk(upload.id, 0, PNG);
    await uploads.complete(upload.id);
    ledger = new TokenLedger(path.join(temp, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000 });
    const unavailable = { name: "unavailable", async probe() { return { provider: "unavailable", available: false, vision: false, acceptsDataUrl: true, reason: "not configured" }; }, async analyze(): Promise<never> { throw new Error("must not run"); } };
    const runner = new ImportJobRunner(store, ledger, { unavailable }, { derivativeRoot: path.join(temp, "media") });
    const job = await runner.createFromUpload(upload.id, { provider: "unavailable" });
    const result = await runner.run(job.id);
    const item = store.listItems(job.id)[0];
    assert.equal(result.status, "paused");
    assert.equal(result.stage, "review_pending");
    assert.equal(item.status, "needs_review");
    assert.equal(item.manualRequired, true);
    assert.equal(item.error?.code, "PROVIDER_UNAVAILABLE");
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

test("mock provider is deterministic and real adapter rejects unsafe endpoint protocols", async () => {
  const provider = new MockVisionProvider();
  const one = await provider.analyze({ bytes: PNG, mimeType: "image/png", filename: "one.png" });
  const two = await provider.analyze({ bytes: PNG, mimeType: "image/png", filename: "one.png" });
  assert.deepEqual(one, two);
  assert.throws(() => new DeepSeekVisionProvider({ baseUrl: "file:///etc/passwd", model: "x", apiKey: "x" }), /HTTPS/i);
});

test("end-to-end mock pipeline yields human-review draft and known usage", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-e2e-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const uploads = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1024, maxUploadBytes: 2048 });
    const upload = await uploads.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await uploads.putChunk(upload.id, 0, PNG);
    await uploads.complete(upload.id);
    ledger = new TokenLedger(path.join(temp, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000 });
    const runner = new ImportJobRunner(store, ledger, { mock: new MockVisionProvider() }, { derivativeRoot: path.join(temp, "media"), requireReview: true, estimatedTokensPerItem: 500 });
    const job = await runner.createFromUpload(upload.id);
    const result = await runner.run(job.id);
    assert.equal(result.status, "succeeded");
    const item = store!.listItems(job.id)[0];
    assert.equal(item.status, "needs_review");
    assert.ok(item.category);
    assert.equal(ledger.getTask(`job:${job.id}`)?.status, "settled");
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

test("non-provider item failures fail the job instead of being reported as successful", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-item-failure-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const uploads = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1_024, maxUploadBytes: 2_048 });
    const upload = await uploads.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await uploads.putChunk(upload.id, 0, PNG);
    await uploads.complete(upload.id);
    ledger = new TokenLedger(path.join(temp, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000 });
    const broken = {
      name: "broken",
      async probe() { return { provider: "broken", available: true, vision: true, acceptsDataUrl: true }; },
      async analyze(): Promise<never> { throw new Error("image pipeline failed"); },
    };
    const runner = new ImportJobRunner(store, ledger, { broken }, { derivativeRoot: path.join(temp, "media"), requireReview: true });
    const job = await runner.createFromUpload(upload.id, { provider: "broken" });

    const result = await runner.run(job.id);
    const item = store.listItems(job.id)[0];
    assert.equal(result.status, "failed");
    assert.equal(item.status, "failed");
    assert.equal(item.manualRequired, false);
    assert.equal(item.lease, undefined);
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

test("missing provider usage pauses before a successful terminal job status", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-usage-pause-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const uploads = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1_024, maxUploadBytes: 2_048 });
    const upload = await uploads.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await uploads.putChunk(upload.id, 0, PNG);
    await uploads.complete(upload.id);
    ledger = new TokenLedger(path.join(temp, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000 });
    const runner = new ImportJobRunner(store, ledger, { mock: new MockVisionProvider({ result: { category: "待审核" } }) }, { derivativeRoot: path.join(temp, "media"), requireReview: true });
    const job = await runner.createFromUpload(upload.id);

    const result = await runner.run(job.id);
    assert.equal(result.status, "paused");
    assert.equal(store.listItems(job.id)[0].status, "needs_review");
    assert.equal(ledger.getTask(`job:${job.id}`)?.status, "paused");
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

test("missing source assets fail cleanly and release the item lease", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-missing-source-"));
  let store: PipelineStore | undefined;
  let ledger: TokenLedger | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const job = store.createJob({ sourceAssetId: "missing-source", itemIds: [], totalItems: 0, provider: "mock", reservedTokens: 0 });
    store.createItem({ jobId: job.id, sourceAssetId: "missing-source" });
    ledger = new TokenLedger(path.join(temp, "budget.json"), { dailyTokenLimit: 10_000, perTaskTokenLimit: 5_000 });
    const runner = new ImportJobRunner(store, ledger, { mock: new MockVisionProvider() }, { derivativeRoot: path.join(temp, "media") });

    const result = await runner.run(job.id);
    const item = store.listItems(job.id)[0];
    assert.equal(result.status, "failed");
    assert.equal(item.error?.code, "ASSET_NOT_FOUND");
    assert.equal(item.manualRequired, false);
    assert.equal(item.lease, undefined);
  } finally { await store?.flush().catch(() => undefined); await ledger?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});
