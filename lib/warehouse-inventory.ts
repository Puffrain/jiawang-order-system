import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { integrationHeaders } from "@/lib/integration-auth";

type Reservation = { operationId: string; orderId: string; lines: Array<{ variantId: string; quantity: number }> };

function endpoint(path: string) {
  const base = process.env.WAREHOUSE_INTERNAL_URL?.replace(/\/$/, "");
  if (!base) throw new Error("WAREHOUSE_INTEGRATION_UNAVAILABLE");
  return `${base}${path}`;
}

async function signedPost<T = unknown>(path: string, payload: object, nonce: string): Promise<T> {
  const body = JSON.stringify(payload);
  const response = await fetch(endpoint(path), { method: "POST", headers: integrationHeaders("POST", path, body, nonce), body, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: { code?: string } };
    throw new Error(result.error?.code === "INSUFFICIENT_STOCK" ? "STOCK" : "WAREHOUSE_INTEGRATION_UNAVAILABLE");
  }
  const result = await response.json().catch(() => ({})) as { data?: T };
  return (result.data ?? result) as T;
}

export async function reserveWarehouseStock(reservation: Reservation) {
  if (!reservation.lines.length) return;
  if (!reservation.operationId || !reservation.orderId || reservation.lines.some(line => !line.variantId || !Number.isSafeInteger(line.quantity) || line.quantity < 1)) throw new Error("WAREHOUSE_INVENTORY_INVALID");
  await signedPost("/warehouse/api/internal/inventory/reserve", reservation, randomUUID());
}

export async function refreshWarehouseStock(skuIds?: string[]) {
  const args: unknown[] = [];
  const where = skuIds?.length ? `AND id IN (${skuIds.map(() => '?').join(',')})` : '';
  if (skuIds?.length) args.push(...skuIds);
  const rows = db.prepare(`SELECT id,warehouse_variant_id warehouseVariantId FROM product_skus WHERE warehouse_variant_id IS NOT NULL AND archived_at IS NULL ${where}`).all(...args) as Array<{ id:string;warehouseVariantId:string }>;
  if (!rows.length) return;
  const path = "/warehouse/api/internal/inventory/levels";
  const result = await signedPost<{levels:Array<{variantId:string;stock:number}>}>(path, { variantIds: rows.map(row => row.warehouseVariantId) }, randomUUID());
  if (!Array.isArray(result.levels)) throw new Error("WAREHOUSE_INVENTORY_INVALID");
  const expected = new Set(rows.map(row => row.warehouseVariantId));
  const levels = new Map<string,number>();
  for (const level of result.levels) {
    if (!level || !expected.has(level.variantId) || levels.has(level.variantId) || !Number.isSafeInteger(level.stock) || level.stock < 0) throw new Error("WAREHOUSE_INVENTORY_INVALID");
    levels.set(level.variantId, level.stock);
  }
  if (levels.size !== expected.size) throw new Error("WAREHOUSE_INVENTORY_INVALID");
  const update = db.prepare('UPDATE product_skus SET stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
  db.transaction(() => { for (const row of rows) update.run(levels.get(row.warehouseVariantId), row.id); })();
}

export async function releaseWarehouseStock(orderId: string, operationId: string = randomUUID()) {
  await signedPost("/warehouse/api/internal/inventory/release", { orderId, operationId }, randomUUID());
}

export function queueWarehouseRelease(orderId: string) {
  const id = randomUUID();
  db.prepare(`INSERT OR IGNORE INTO inventory_compensations(id,order_id,operation_id,next_attempt_at) VALUES(?,?,?,?)`).run(id, orderId, id, new Date().toISOString());
}

export async function processWarehouseReleases(limit = 10) {
  const rows = db.prepare(`SELECT id,order_id orderId,operation_id operationId,attempt_count attemptCount FROM inventory_compensations WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?`).all(new Date().toISOString(), limit) as Array<{id:string;orderId:string;operationId:string;attemptCount:number}>;
  for (const row of rows) {
    try {
      await releaseWarehouseStock(row.orderId, row.operationId);
      db.prepare(`UPDATE inventory_compensations SET status='completed',completed_at=?,updated_at=? WHERE id=?`).run(new Date().toISOString(), new Date().toISOString(), row.id);
    } catch (error) {
      const attempts = row.attemptCount + 1;
      db.prepare(`UPDATE inventory_compensations SET attempt_count=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?`).run(attempts, new Date(Date.now()+Math.min(3600_000,1000*2**Math.min(attempts,10))).toISOString(), error instanceof Error?error.message.slice(0,200):"release failed", new Date().toISOString(), row.id);
    }
  }
}
