import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import db from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { integrationHeaders } from "@/lib/integration-auth";
import { uploadRoot } from "@/lib/product-catalog";

const MAX_IMAGES = 8;
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LEASE_MS = 10 * 60_000;
const MAX_PIXELS = 25_000_000;
const stable = (value: string) => createHash("sha256").update(value).digest("hex");

type MediaJob = {
  productId: string;
  warehouseProductId: string;
  warehouseRevision: number;
  mediaRevision: number;
  assetIdsJson: string;
  attemptCount: number;
  claimToken: string;
};

type MediaFileOperations = {
  unlink?: typeof fs.unlink;
};

function imageType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.slice(0, 8).every((value, index) => value === [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][index])) return { mime: "image/png", ext: "png" };
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6)))) return { mime: "image/gif", ext: "gif" };
  return null;
}

async function validateDecodedImage(bytes: Uint8Array, expectedMime: string) {
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS });
    const metadata = await image.metadata();
    const mimeByFormat: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    if (!metadata.format || mimeByFormat[metadata.format] !== expectedMime || !metadata.width || !metadata.height
      || metadata.width * metadata.height > MAX_PIXELS) throw new Error("invalid image metadata");
    await image.clone().resize({ width: 1, height: 1, fit: "inside" }).raw().toBuffer();
  } catch {
    throw new Error("WAREHOUSE_MEDIA_INVALID");
  }
}

function endpoint(pathname: string) {
  const base = process.env.WAREHOUSE_INTERNAL_URL?.replace(/\/$/, "");
  if (!base) throw new Error("WAREHOUSE_INTEGRATION_UNAVAILABLE");
  return `${base}${pathname}`;
}

function assertCurrentProjection(productId: string, warehouseProductId: string, warehouseRevision: number, mediaRevision: number) {
  const product = db.prepare("SELECT warehouse_product_id warehouseProductId,warehouse_revision warehouseRevision,warehouse_media_revision mediaRevision,status,archived_at archivedAt,permanently_hidden_at permanentlyHiddenAt FROM products WHERE id=?")
    .get(productId) as { warehouseProductId: string | null; warehouseRevision: number | null; mediaRevision: number | null; status: string; archivedAt: string | null; permanentlyHiddenAt: string | null } | undefined;
  if (!product || product.warehouseProductId !== warehouseProductId || product.warehouseRevision !== warehouseRevision
    || product.mediaRevision !== mediaRevision || product.status !== "active" || product.archivedAt || product.permanentlyHiddenAt) {
    throw new Error("WAREHOUSE_MEDIA_STALE");
  }
}

function assertCurrentClaim(productId: string, warehouseRevision: number, mediaRevision: number, claimToken: string) {
  const now = new Date().toISOString();
  const claim = db.prepare(`SELECT 1 FROM warehouse_media_sync
    WHERE product_id=? AND warehouse_revision=? AND media_revision=? AND status='pending'
      AND claim_token=? AND lease_expires_at>?`).get(productId, warehouseRevision, mediaRevision, claimToken, now);
  if (!claim) throw new Error("WAREHOUSE_MEDIA_CLAIM_LOST");
}

export async function syncWarehouseProductMedia(productId: string, warehouseProductId: string, warehouseRevision: number, mediaRevision: number, assetIds: string[], claimToken: string, fileOperations: MediaFileOperations = {}) {
  const unlink = fileOperations.unlink ?? fs.unlink;
  assertCurrentProjection(productId, warehouseProductId, warehouseRevision, mediaRevision);
  assertCurrentClaim(productId, warehouseRevision, mediaRevision, claimToken);
  const desired = [...new Set(assetIds.filter(Boolean))].slice(0, MAX_IMAGES);
  const existing = db.prepare("SELECT id,warehouse_asset_id warehouseAssetId,storage_key storageKey FROM product_images WHERE product_id=? AND warehouse_asset_id IS NOT NULL").all(productId) as Array<{id:string;warehouseAssetId:string;storageKey:string}>;
  const byAsset = new Map(existing.map((row) => [row.warehouseAssetId, row]));
  const fetched: Array<{ assetId:string; imageId:string; storageKey:string; mime:string; bytes:Uint8Array }> = [];

  for (const assetId of desired) {
    const current = byAsset.get(assetId);
    // A newer media revision may reuse the same asset id with different bytes.
    // Always fetch the current revision; the database transaction below keeps
    // the old row until the replacement is committed, then cleanup removes the
    // no-longer-referenced file.
    const pathname = `/warehouse/api/internal/products/${encodeURIComponent(warehouseProductId)}/media/${encodeURIComponent(assetId)}`;
    const response = await fetch(endpoint(pathname), { method: "GET", headers: integrationHeaders("GET", pathname, "", randomUUID()), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`WAREHOUSE_MEDIA_${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) throw new Error("WAREHOUSE_MEDIA_TOO_LARGE");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("WAREHOUSE_MEDIA_TOO_LARGE");
    const type = imageType(bytes);
    if (!type || response.headers.get("content-type")?.split(";")[0] !== type.mime) throw new Error("WAREHOUSE_MEDIA_INVALID");
    await validateDecodedImage(bytes, type.mime);
    const digest = stable([warehouseProductId, warehouseRevision, mediaRevision, assetId, claimToken].join(":"));
    fetched.push({ assetId, imageId: current?.id || `whi-${stable(assetId).slice(0, 24)}`, storageKey: `warehouse-${digest}.${type.ext}`, mime: type.mime, bytes });
  }

  const written: string[] = [];
  let committed = false;
  try {
    for (const item of fetched) {
      assertCurrentClaim(productId, warehouseRevision, mediaRevision, claimToken);
      const temp = path.join(uploadRoot, `.warehouse-${randomUUID()}.tmp`);
      await fs.writeFile(temp, item.bytes, { flag: "wx" });
      try {
        await fs.rename(temp, path.join(uploadRoot, item.storageKey));
        written.push(item.storageKey);
      } catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        try { await fs.access(path.join(uploadRoot, item.storageKey)); } catch { throw error; }
      }
    }

    const stale = existing.filter((row) => !desired.includes(row.warehouseAssetId));
    const replaced = fetched.flatMap((item) => {
      const prior = byAsset.get(item.assetId);
      return prior && prior.storageKey !== item.storageKey ? [prior] : [];
    });
    db.transaction(() => {
      assertCurrentProjection(productId, warehouseProductId, warehouseRevision, mediaRevision);
      assertCurrentClaim(productId, warehouseRevision, mediaRevision, claimToken);
      const manualCount = (db.prepare("SELECT COUNT(*) count FROM product_images WHERE product_id=? AND warehouse_asset_id IS NULL").get(productId) as {count:number}).count;
      for (const row of stale) db.prepare("DELETE FROM product_images WHERE id=?").run(row.id);
      for (const row of [...stale, ...replaced]) {
        db.prepare("INSERT OR IGNORE INTO product_file_cleanup(storage_key,product_id) VALUES(?,?)").run(row.storageKey, productId);
      }
      for (const [index, assetId] of desired.entries()) {
        const downloaded = fetched.find((item) => item.assetId === assetId);
        const current = byAsset.get(assetId);
        if (downloaded) db.prepare(`INSERT INTO product_images(id,product_id,storage_key,mime_type,byte_size,sort_order,is_primary,warehouse_asset_id) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT DO UPDATE SET product_id=excluded.product_id,storage_key=excluded.storage_key,mime_type=excluded.mime_type,byte_size=excluded.byte_size,sort_order=excluded.sort_order,is_primary=excluded.is_primary,warehouse_asset_id=excluded.warehouse_asset_id`).run(downloaded.imageId, productId, downloaded.storageKey, downloaded.mime, downloaded.bytes.length, index, manualCount === 0 && index === 0 ? 1 : 0, assetId);
        else if (current) db.prepare("UPDATE product_images SET sort_order=?,is_primary=? WHERE id=?").run(index, manualCount === 0 && index === 0 ? 1 : 0, current.id);
      }
      const completed = db.prepare(`UPDATE warehouse_media_sync
        SET status='synced',last_error=NULL,claim_token=NULL,lease_expires_at=NULL,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE product_id=? AND warehouse_revision=? AND media_revision=? AND status='pending' AND claim_token=? AND lease_expires_at>?`)
        .run(productId, warehouseRevision, mediaRevision, claimToken, new Date().toISOString());
      if (completed.changes !== 1) throw new Error("WAREHOUSE_MEDIA_CLAIM_LOST");
    })();
    committed = true;
    for (const row of [...stale, ...replaced]) {
      try {
        await unlink(path.join(uploadRoot, row.storageKey));
        db.prepare("DELETE FROM product_file_cleanup WHERE storage_key=?").run(row.storageKey);
      } catch (error) {
        db.prepare("UPDATE product_file_cleanup SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE storage_key=?")
          .run(error instanceof Error ? error.message.slice(0, 300) : "unlink_failed", row.storageKey);
      }
    }
  } catch (error) {
    // Once the projection transaction commits, the new files are authoritative.
    // Cleanup failures must remain retryable and must never remove those files.
    if (!committed) {
      await Promise.all(written.map((storageKey) => fs.unlink(path.join(uploadRoot, storageKey)).catch(() => undefined)));
    }
    throw error;
  }
}

export function queueWarehouseProductMedia(productId: string, warehouseProductId: string, warehouseRevision: number, mediaRevision: number, assetIds: string[], error = "") {
  const normalized = [...new Set(assetIds.filter(Boolean))].slice(0, MAX_IMAGES);
  db.prepare(`INSERT INTO warehouse_media_sync(id,product_id,warehouse_product_id,warehouse_revision,media_revision,asset_ids_json,status,attempt_count,last_error,next_attempt_at,claim_token,lease_expires_at,completed_at,updated_at)
    VALUES(?,?,?,?,?,?,'pending',0,?,CURRENT_TIMESTAMP,NULL,NULL,NULL,CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET warehouse_product_id=excluded.warehouse_product_id,warehouse_revision=excluded.warehouse_revision,media_revision=excluded.media_revision,asset_ids_json=excluded.asset_ids_json,status='pending',attempt_count=0,last_error=excluded.last_error,next_attempt_at=CURRENT_TIMESTAMP,claim_token=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE excluded.warehouse_revision > warehouse_media_sync.warehouse_revision
      OR (excluded.warehouse_revision = warehouse_media_sync.warehouse_revision AND excluded.media_revision > warehouse_media_sync.media_revision)`)
    .run(randomUUID(), productId, warehouseProductId, warehouseRevision, mediaRevision, JSON.stringify(normalized), error ? error.slice(0, 300) : null);
}

export function claimPendingWarehouseMedia(limit = 4, leaseMs = DEFAULT_LEASE_MS): MediaJob[] {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + Math.max(60_000, leaseMs)).toISOString();
  return db.transaction(() => {
    const candidates = db.prepare(`SELECT product_id productId,warehouse_product_id warehouseProductId,warehouse_revision warehouseRevision,media_revision mediaRevision,asset_ids_json assetIdsJson,attempt_count attemptCount
      FROM warehouse_media_sync WHERE status='pending' AND next_attempt_at<=? AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)
      ORDER BY updated_at LIMIT ?`).all(now, now, Math.max(1, limit)) as Array<Omit<MediaJob, "claimToken">>;
    const claimed: MediaJob[] = [];
    const claim = db.prepare(`UPDATE warehouse_media_sync SET claim_token=?,lease_expires_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE product_id=? AND warehouse_revision=? AND media_revision=? AND status='pending' AND next_attempt_at<=? AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`);
    for (const candidate of candidates) {
      const claimToken = randomUUID();
      if (claim.run(claimToken, leaseExpiresAt, candidate.productId, candidate.warehouseRevision, candidate.mediaRevision, now, now).changes === 1) claimed.push({ ...candidate, claimToken });
    }
    return claimed;
  }).immediate();
}

export async function retryPendingWarehouseMedia(limit = 4, fileOperations: MediaFileOperations = {}) {
  const rows = claimPendingWarehouseMedia(limit);
  for (const row of rows) {
    try {
      const assetIds = JSON.parse(row.assetIdsJson) as unknown;
      if (!Array.isArray(assetIds) || assetIds.some((value) => typeof value !== "string")) throw new Error("WAREHOUSE_MEDIA_QUEUE_INVALID");
      await syncWarehouseProductMedia(row.productId, row.warehouseProductId, row.warehouseRevision, row.mediaRevision, assetIds, row.claimToken, fileOperations);
      writeAudit({ actorRole: "system", action: "warehouse.product_media.synced", objectType: "warehouse_product", objectId: row.warehouseProductId, metadata: { productId: row.productId, revision: row.warehouseRevision, mediaRevision: row.mediaRevision } });
    } catch (error) {
      const attempts = row.attemptCount + 1;
      const message = error instanceof Error ? error.message.slice(0,300) : "WAREHOUSE_MEDIA_SYNC_FAILED";
      const terminal = message === "WAREHOUSE_MEDIA_QUEUE_INVALID" || message === "WAREHOUSE_MEDIA_STALE";
      if (message === "WAREHOUSE_MEDIA_CLAIM_LOST") continue;
      const failureTimestamp = new Date().toISOString();
      const failed = db.prepare(`UPDATE warehouse_media_sync SET status=?,attempt_count=?,last_error=?,next_attempt_at=?,claim_token=NULL,lease_expires_at=NULL,completed_at=CASE WHEN ?='synced' THEN CURRENT_TIMESTAMP ELSE completed_at END,updated_at=CURRENT_TIMESTAMP
        WHERE product_id=? AND warehouse_revision=? AND media_revision=? AND status='pending' AND claim_token=? AND lease_expires_at>?`).run(terminal ? "synced" : "pending", attempts, message, new Date(Date.now()+Math.min(3_600_000,1000*2**Math.min(attempts,10))).toISOString(), terminal ? "synced" : "pending", row.productId, row.warehouseRevision, row.mediaRevision, row.claimToken, failureTimestamp);
      if (failed.changes !== 1) continue;
      writeAudit({ actorRole: "system", action: terminal ? "warehouse.product_media.stale" : "warehouse.product_media.retry", objectType: "warehouse_product", objectId: row.warehouseProductId, metadata: { productId: row.productId, revision: row.warehouseRevision, mediaRevision: row.mediaRevision, attempts, error: message } });
    }
  }
  return rows.length;
}
