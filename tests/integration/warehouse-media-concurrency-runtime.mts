import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const runtimeDir = path.join(process.cwd(), ".task-runs", `warehouse-media-${Date.now()}`);
const uploadDir = path.join(runtimeDir, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
process.env.DATABASE_URL = `file:${path.join(runtimeDir, "app.db")}`;
process.env.UPLOAD_DIR = uploadDir;
process.env.SEED_SAMPLE_PRODUCTS = "false";
process.env.INTEGRATION_SHARED_SECRET = "media-runtime-secret-at-least-32-characters";
process.env.WAREHOUSE_INTERNAL_URL = "http://warehouse.test";
process.env.MEDIA_WORKER_TEST_MODE = "1";

const db = (await import("../../lib/db")).default;
await import("../../lib/product-catalog");
const { queueWarehouseProductMedia, retryPendingWarehouseMedia } = await import("../../lib/warehouse-product-media");
const { retryProductFileCleanup } = await import("../../lib/product-file-cleanup");
const { runMediaWorkerOnce } = await import("../../scripts/media-worker");

const productId = "media-runtime-product";
const warehouseProductId = "warehouse-media-product";
const assetId = "shared-asset";
const png = async (marker: number) => new Uint8Array(await sharp({
  create: { width: 2, height: 2, channels: 4, background: { r: marker, g: 255 - marker, b: marker * 2, alpha: 1 } },
}).png().toBuffer());
const response = (bytes: Uint8Array) => new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
const originalFetch = globalThis.fetch;
const realUnlink = (await import("node:fs/promises")).unlink;

function setProjection(warehouseRevision: number, mediaRevision: number) {
  db.prepare(`UPDATE products SET warehouse_revision=?,warehouse_media_revision=?,warehouse_sale_status='active',status='active',archived_at=NULL,permanently_hidden_at=NULL WHERE id=?`)
    .run(warehouseRevision, mediaRevision, productId);
}

function currentImage() {
  return db.prepare("SELECT storage_key storageKey FROM product_images WHERE product_id=? AND warehouse_asset_id=?").get(productId, assetId) as { storageKey: string };
}

try {
  const images = new Map(await Promise.all([1, 2, 3, 4].map(async (marker) => [marker, await png(marker)] as const)));
  const image = (marker: number) => images.get(marker)!;
  db.prepare(`INSERT INTO products(id,name,category,status,warehouse_product_id,warehouse_revision,warehouse_media_revision,warehouse_sale_status) VALUES(?,?,?,'active',?,1,1,'active')`)
    .run(productId, "Media Runtime Product", "Media", warehouseProductId);

  globalThis.fetch = async () => response(image(1));
  queueWarehouseProductMedia(productId, warehouseProductId, 1, 1, [assetId]);
  assert.equal(await retryPendingWarehouseMedia(1), 1);
  const seed = currentImage();
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(uploadDir, seed.storageKey))), image(1));

  setProjection(1, 2);
  queueWarehouseProductMedia(productId, warehouseProductId, 1, 2, [assetId]);
  let releaseOld!: () => void;
  let oldFetchStarted!: () => void;
  const oldFetchGate = new Promise<void>((resolve) => { oldFetchStarted = resolve; });
  const oldReleaseGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      oldFetchStarted();
      await oldReleaseGate;
      return response(image(2));
    }
    return response(image(3));
  };

  const staleWorker = retryPendingWarehouseMedia(1);
  await oldFetchGate;
  setProjection(2, 3);
  queueWarehouseProductMedia(productId, warehouseProductId, 2, 3, [assetId]);

  const failSeedUnlink: typeof realUnlink = async (target) => {
    if (String(target).endsWith(seed.storageKey)) throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
    return realUnlink(target);
  };
  assert.equal(await retryPendingWarehouseMedia(1, { unlink: failSeedUnlink }), 1);
  const newest = currentImage();
  assert.notEqual(newest.storageKey, seed.storageKey, "a reused asset id must receive a revision-specific storage key");
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(uploadDir, newest.storageKey))), image(3));
  assert.ok(db.prepare("SELECT 1 FROM product_file_cleanup WHERE storage_key=?").get(seed.storageKey), "failed unlink remains retryable");

  releaseOld();
  assert.equal(await staleWorker, 1, "the stale worker consumed one claim but cannot commit it");
  assert.equal(currentImage().storageKey, newest.storageKey);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(uploadDir, newest.storageKey))), image(3));
  assert.equal((db.prepare(`SELECT COUNT(*) count FROM audit_logs WHERE action='warehouse.product_media.synced'`).get() as { count: number }).count, 2, "only seed and newest workers may audit success");
  assert.equal((db.prepare(`SELECT COUNT(*) count FROM audit_logs WHERE action='warehouse.product_media.retry' AND object_id=?`).get(warehouseProductId) as { count: number }).count, 0, "a stale claim cannot audit a retry");

  await retryProductFileCleanup(10);
  assert.equal(db.prepare("SELECT 1 FROM product_file_cleanup WHERE storage_key=?").get(seed.storageKey), undefined);
  assert.equal(fs.existsSync(path.join(uploadDir, seed.storageKey)), false);
  assert.equal(fs.existsSync(path.join(uploadDir, newest.storageKey)), true);

  setProjection(3, 4);
  queueWarehouseProductMedia(productId, warehouseProductId, 3, 4, [assetId]);
  globalThis.fetch = async () => { throw new Error("temporary warehouse outage"); };
  await runMediaWorkerOnce();
  const failed = db.prepare("SELECT status,attempt_count attempts,last_error lastError FROM warehouse_media_sync WHERE product_id=?").get(productId) as { status: string; attempts: number; lastError: string };
  assert.equal(failed.status, "pending");
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /temporary warehouse outage/);

  db.prepare("UPDATE warehouse_media_sync SET next_attempt_at=? WHERE product_id=?").run(new Date(0).toISOString(), productId);
  globalThis.fetch = async () => response(image(4));
  await runMediaWorkerOnce();
  const recovered = db.prepare("SELECT status,attempt_count attempts FROM warehouse_media_sync WHERE product_id=?").get(productId) as { status: string; attempts: number };
  assert.equal(recovered.status, "synced", "the standalone worker repairs media without buyer traffic");
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(uploadDir, currentImage().storageKey))), image(4));

  setProjection(4, 5);
  queueWarehouseProductMedia(productId, warehouseProductId, 4, 5, [assetId]);
  globalThis.fetch = async () => response(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]));
  await runMediaWorkerOnce();
  const invalid = db.prepare("SELECT status,last_error lastError FROM warehouse_media_sync WHERE product_id=?").get(productId) as { status: string; lastError: string };
  assert.equal(invalid.status, "pending");
  assert.equal(invalid.lastError, "WAREHOUSE_MEDIA_INVALID");
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(uploadDir, currentImage().storageKey))), image(4), "a truncated image cannot replace the valid projection");

  console.log("warehouse media concurrency and standalone retry runtime: PASS");
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
