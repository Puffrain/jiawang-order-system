import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { closeDb, getDb } from "../../lib/db";
import { ChunkedUploadService, type UploadWriteLeaseRunner } from "../../lib/ingest/chunked-upload";
import { PipelineStore } from "../../lib/jobs/store";
import {
  acquireWriteLease,
  clearMaintenanceMode,
  enterMaintenanceMode,
  MaintenanceError,
  releaseWriteLease,
  renewWriteLease,
  waitForWriteLeases,
  WriteLeaseError,
  type WriteLeaseContext,
  type WriteLeaseRecord,
} from "../../lib/maintenance";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("chunk uploads use the injected write gate and abort a lost completion lease", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-write-gate-"));
  const store = new PipelineStore(path.join(temp, "state.json"));
  const observed: string[] = [];
  const runner: UploadWriteLeaseRunner = async (kind, operation) => {
    observed.push(kind);
    return operation(fakeContext());
  };
  try {
    const service = new ChunkedUploadService(
      store,
      path.join(temp, "media"),
      { maxChunkBytes: 1_024, maxUploadBytes: 2_048 },
      runner
    );
    const completedUpload = await service.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await service.putChunk(completedUpload.id, 0, PNG);
    await service.complete(completedUpload.id);
    const cancelledUpload = await service.create({ filename: "two.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await service.cancel(cancelledUpload.id);
    assert.deepEqual(observed, ["upload.create", "upload.chunk", "upload.complete", "upload.create", "upload.cancel"]);

    let completeRenewals = 0;
    const losingRunner: UploadWriteLeaseRunner = async (kind, operation) => {
      const context = fakeContext(() => {
        if (kind === "upload.complete" && ++completeRenewals === 2) {
          throw new WriteLeaseError("lost in test", "WRITE_LEASE_LOST", 409);
        }
      });
      return operation(context);
    };
    const losingService = new ChunkedUploadService(
      store,
      path.join(temp, "media"),
      { maxChunkBytes: 1_024, maxUploadBytes: 2_048 },
      losingRunner
    );
    const interrupted = await losingService.create({ filename: "three.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await losingService.putChunk(interrupted.id, 0, PNG);
    await assert.rejects(
      losingService.complete(interrupted.id),
      (error: unknown) => error instanceof WriteLeaseError && error.code === "WRITE_LEASE_LOST"
    );
    assert.equal(store.getUpload(interrupted.id)?.status, "uploading");
    const originals = path.join(temp, "media", "originals");
    assert.deepEqual(await fs.readdir(originals), [path.basename(store.getAsset(store.getUpload(completedUpload.id)!.originalAssetId!)!.path)]);
  } finally {
    await store.flush().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("chunk body producers are consumed only after the write gate is held", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-write-gate-body-"));
  const store = new PipelineStore(path.join(temp, "state.json"));
  let leaseHeld = false;
  let producerStarted = false;
  let producerFinished = false;
  const runner: UploadWriteLeaseRunner = async (_kind, operation) => {
    leaseHeld = true;
    try { return await operation(fakeContext()); }
    finally { leaseHeld = false; }
  };
  try {
    const service = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1_024, maxUploadBytes: 2_048 }, runner);
    const upload = await service.create({ filename: "body.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await service.putChunk(upload.id, 0, async () => {
      producerStarted = true;
      assert.equal(leaseHeld, true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      producerFinished = true;
      return PNG;
    });
    assert.equal(producerStarted, true);
    assert.equal(producerFinished, true);
    assert.equal(leaseHeld, false);
  } finally {
    await store.flush().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("write leases arbitrate maintenance, drain, and reclaim expired rows", async (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as unknown as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = "test";
  closeDb();
  try {
    try {
      getDb();
    } catch (error) {
      if (/Could not locate the bindings file|NODE_MODULE_VERSION/i.test(error instanceof Error ? error.message : String(error))) {
        t.skip("better-sqlite3 native binding is unavailable for this Node runtime");
        return;
      }
      throw error;
    }

    const first = acquireWriteLease("upload.complete", { owner: "request:first", ttlMs: 10_000, heartbeat: false });
    enterMaintenanceMode("backup:test-owner", "test maintenance");
    assert.throws(
      () => acquireWriteLease("upload.chunk", { owner: "request:blocked" }),
      (error: unknown) => error instanceof MaintenanceError && error.code === "MAINTENANCE"
    );

    // Existing work is allowed to heartbeat after maintenance starts, while
    // the waiter must not report a drained system until that work releases.
    const renewed = renewWriteLease(first, 10_000);
    assert.ok(Date.parse(renewed.expiresAt) >= Date.parse(first.expiresAt));
    await assert.rejects(
      waitForWriteLeases({ maintenanceOwner: "backup:test-owner", timeoutMs: 5, pollIntervalMs: 1 }),
      (error: unknown) => error instanceof WriteLeaseError && error.code === "WRITE_LEASE_TIMEOUT"
    );
    assert.equal(releaseWriteLease(renewed), true);
    await waitForWriteLeases({ maintenanceOwner: "backup:test-owner", timeoutMs: 100, pollIntervalMs: 1 });
    assert.equal(clearMaintenanceMode("backup:test-owner"), true);

    // A crashed writer's expired row is removed by the next atomic acquire.
    const expired = acquireWriteLease("upload.chunk", { owner: "request:expired", ttlMs: 10_000, heartbeat: false });
    getDb().prepare("UPDATE write_leases SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), expired.id);
    const replacement = acquireWriteLease("upload.chunk", { owner: "request:replacement", ttlMs: 10_000, heartbeat: false });
    const oldRow = getDb().prepare("SELECT id FROM write_leases WHERE id = ?").get(expired.id);
    assert.equal(oldRow, undefined);
    assert.equal(releaseWriteLease(replacement), true);
  } finally {
    try { clearMaintenanceMode("backup:test-owner", true); } catch { /* database may be unavailable/skipped */ }
    closeDb();
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousNodeEnv;
  }
});

function fakeContext(beforeRenew?: () => void): WriteLeaseContext {
  const lease: WriteLeaseRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    owner: "test",
    kind: "upload.test",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    lease,
    renew() { beforeRenew?.(); return lease; },
    assertActive() { return lease; },
  };
}
