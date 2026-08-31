import assert from "node:assert/strict";
import { createHmac, createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import Database from "better-sqlite3";

const secret = "integration-test-secret-at-least-32-characters";
const body = JSON.stringify({ id: "warehouse-product-1", revision: 3 });
const path = "/api/internal/warehouse/products";
const timestamp = String(Date.now());
const nonce = randomUUID();
const digest = createHash("sha256").update(body).digest("hex");
const canonical = `${timestamp}.${nonce}.POST.${path}.${digest}`;
const signature = createHmac("sha256", secret).update(canonical).digest("hex");
assert.equal(signature.length, 64);
assert.notEqual(createHmac("sha256", secret).update(`${timestamp}.${nonce}.POST.${path}.${createHash("sha256").update(body + "tampered").digest("hex")}`).digest("hex"), signature);

const stable = (prefix, value) => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
assert.equal(stable("whp", "warehouse-product-1"), stable("whp", "warehouse-product-1"));
assert.notEqual(stable("whp", "warehouse-product-1"), stable("whp", "warehouse-product-2"));

const root = process.cwd();
const orderProxy = fs.readFileSync(nodePath.join(root, "proxy.ts"), "utf8");
const warehouseProxy = fs.readFileSync(nodePath.join(root, "佳旺仓库系统/proxy.ts"), "utf8");
const orderSave = fs.readFileSync(nodePath.join(root, "lib/product-catalog.ts"), "utf8");
assert.ok(orderProxy.includes('pathname.startsWith("/api/internal/")'), "order proxy must allow HMAC-authenticated internal routes without a browser session");
assert.ok(warehouseProxy.includes("pathname.startsWith('/warehouse/api/internal/')"), "warehouse proxy must keep service calls outside browser Origin enforcement");
assert.match(orderSave, /if \(owned\.warehouseVariantId\)[\s\S]*sku\.stock !== current\.stock[\s\S]*WAREHOUSE_SKU_MANAGED/, "order edits must reject changes to warehouse-managed SKU price and stock");
assert.match(orderSave, /WAREHOUSE_SKU_MANAGED/, "warehouse SKU membership must be protected server-side");

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE IF NOT EXISTS product_variants(id TEXT PRIMARY KEY,stock INTEGER,updated_at TEXT);
  CREATE TABLE IF NOT EXISTS inventory_operations(operation_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,kind TEXT NOT NULL,related_operation_id TEXT,lines_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(order_id,kind));
  INSERT OR IGNORE INTO product_variants VALUES('variant-1',10,CURRENT_TIMESTAMP);
`);
function reserve(orderId, operationId, quantity) {
  return db.transaction(() => {
    const replay = db.prepare("SELECT lines_json FROM inventory_operations WHERE order_id=? AND kind='reserve'").get(orderId);
    if (replay) return true;
    const changed = db.prepare("UPDATE product_variants SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id='variant-1' AND stock>=?").run(quantity, quantity);
    if (changed.changes !== 1) throw new Error("STOCK");
    db.prepare("INSERT INTO inventory_operations VALUES(?,?,'reserve',NULL,?,CURRENT_TIMESTAMP)").run(operationId, orderId, JSON.stringify([{ variantId: "variant-1", quantity }]));
    return false;
  })();
}
function release(orderId, operationId) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM inventory_operations WHERE order_id=? AND kind='release'").get(orderId)) return true;
    const reserved = db.prepare("SELECT operation_id,lines_json FROM inventory_operations WHERE order_id=? AND kind='reserve'").get(orderId);
    if (!reserved) throw new Error("NOT_FOUND");
    const lines = JSON.parse(reserved.lines_json);
    for (const line of lines) db.prepare("UPDATE product_variants SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(line.quantity, line.variantId);
    db.prepare("INSERT INTO inventory_operations VALUES(?,?,'release',?,?,CURRENT_TIMESTAMP)").run(operationId, orderId, reserved.operation_id, reserved.lines_json);
    return false;
  })();
}
assert.equal(reserve("order-1", "reserve-1", 3), false);
assert.equal(reserve("order-1", "reserve-2", 3), true);
assert.equal(db.prepare("SELECT stock FROM product_variants WHERE id='variant-1'").get().stock, 7);
assert.throws(() => reserve("order-2", "reserve-3", 8), /STOCK/);
assert.equal(db.prepare("SELECT stock FROM product_variants WHERE id='variant-1'").get().stock, 7, "failed reserve must roll back");
assert.equal(release("order-1", "release-1"), false);
assert.equal(release("order-1", "release-2"), true);
assert.equal(db.prepare("SELECT stock FROM product_variants WHERE id='variant-1'").get().stock, 10);

console.log("PASS warehouse integration wire contract");
