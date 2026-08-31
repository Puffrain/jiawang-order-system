import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.join(process.cwd(), ".task-runs", `production-data-check-${Date.now()}`);
const uploads = path.join(root, "uploads");
fs.mkdirSync(uploads, { recursive: true });
const script = path.resolve("scripts/production-data-check.cjs");
const run = (mode, database, env = {}) => spawnSync(process.execPath, [script, mode, database], {
  encoding: "utf8",
  env: { ...process.env, ...env },
});

try {
  const orderPath = path.join(root, "order.db");
  const order = new Database(orderPath);
  order.exec(`
    CREATE TABLE products(id TEXT, status TEXT, archived_at TEXT, warehouse_product_id TEXT);
    CREATE TABLE product_skus(id TEXT, archived_at TEXT, warehouse_variant_id TEXT);
    CREATE TABLE product_images(storage_key TEXT, warehouse_asset_id TEXT);
    CREATE TABLE warehouse_media_sync(status TEXT, attempt_count INTEGER, last_error TEXT, next_attempt_at TEXT, updated_at TEXT);
    CREATE TABLE loyalty_accounts(id TEXT);
    CREATE TABLE orders(id TEXT);
    INSERT INTO product_images VALUES ('present.png', 'asset-1'), ('missing.png', 'asset-2');
    INSERT INTO warehouse_media_sync VALUES ('pending', 0, NULL, NULL, CURRENT_TIMESTAMP);
  `);
  order.close();
  fs.writeFileSync(path.join(uploads, "present.png"), "ok");

  const blockedOrder = run("order", orderPath, { UPLOAD_DIR: uploads });
  assert.notEqual(blockedOrder.status, 0, "missing media and pending work must block finalization");
  assert.match(blockedOrder.stderr, /exceeds allowed maximum/);
  const approvedOrder = run("order", orderPath, {
    UPLOAD_DIR: uploads,
    MAX_PENDING_MEDIA: "1",
    MAX_MISSING_IMAGES: "1",
  });
  assert.equal(approvedOrder.status, 0, approvedOrder.stderr);

  const warehousePath = path.join(root, "warehouse.db");
  const warehouse = new Database(warehousePath);
  warehouse.exec(`
    CREATE TABLE products(id TEXT, status TEXT);
    CREATE TABLE product_variants(id TEXT, product_id TEXT);
    CREATE TABLE product_assets(id TEXT, product_id TEXT);
    CREATE TABLE order_sync_outbox(status TEXT);
    CREATE TABLE inventory_operations(id TEXT);
    INSERT INTO order_sync_outbox VALUES ('dead');
  `);
  warehouse.close();
  const blockedWarehouse = run("warehouse", warehousePath);
  assert.notEqual(blockedWarehouse.status, 0, "dead sync rows must block finalization");
  assert.equal(run("warehouse", warehousePath, { MAX_SYNC_DEAD: "1" }).status, 0);
  console.log("production data finalization thresholds: PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
