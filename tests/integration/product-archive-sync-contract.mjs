import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const proxy = read("proxy.ts");
const catalog = read("lib/product-catalog.ts");
const projection = read("app/api/internal/warehouse/products/route.ts");
const orderSync = read("佳旺仓库系统/lib/order-sync.ts");
const warehouseCatalog = read("佳旺仓库系统/lib/catalog-repository.ts");
const reserve = read("佳旺仓库系统/app/api/internal/inventory/reserve/route.ts");
const release = read("佳旺仓库系统/app/api/internal/inventory/release/route.ts");
const media = read("lib/warehouse-product-media.ts");
const migration021 = read("佳旺仓库系统/migrations/021_order_sync_and_inventory_safety.sql");

assert.match(proxy, /sharedBuyerProductDetail/, "merchant product preview must be a narrow shared route");
assert.ok(proxy.includes('pathname.startsWith("/api/cart")'), "cart must remain buyer-only");
assert.ok(proxy.includes('pathname.startsWith("/api/loyalty")'), "loyalty must remain buyer-only");

assert.match(catalog, /category_key|categoryKey/, "catalog needs a stable category key for related products");
assert.match(catalog, /product_recommendations/, "catalog needs persisted merchant recommendations");
assert.match(catalog, /warehouse_product_id/, "warehouse provenance must stay visible in the catalog");

assert.match(projection, /payloadHash/, "order projection must require a payload hash");
assert.match(projection, /eventType/, "order projection must require an event type");
assert.match(projection, /saleStatus/, "order projection must require an explicit sale status");
assert.match(projection, /variants.length|Array.isArray(body.variants)/, "projection must validate variants while allowing inactive tombstones");
assert.match(projection, /warehouse_revision/, "projection must retain the current warehouse revision");

assert.match(orderSync, /payloadHash/, "outbox payloads need deterministic hashes");
assert.match(orderSync, /superseded/, "old pending outbox rows must be superseded");
assert.match(orderSync, /eventType/, "outbox needs an explicit event type");
assert.match(orderSync, /categoryKey/, "outbox must carry the stable category key");
assert.match(warehouseCatalog, /ever_published_at|everPublishedAt/, "warehouse must preserve publication history");
assert.match(warehouseCatalog, /archived_at|archivedAt/, "warehouse SKU deletion must be soft-delete based");

assert.ok(reserve.includes("products.status='published'"), "warehouse reservation must reject unpublished products");
assert.match(release, /changes !== 1|changes===1|changes != 1/, "warehouse release must verify every stock restore");
assert.match(media, /revision/, "media jobs must be versioned");
assert.match(media, /lease|claimed_at|claim/i, "media jobs must have an atomic claim or lease");
assert.match(orderSync, /const claimNext = (): OutboxRow | null/, "outbox must claim one row immediately before delivery");
assert.match(orderSync, /LIMIT 1/, "outbox claims must not lease an unprocessed batch");
assert.ok(migration021.includes("CASE WHEN json_valid(payload_json)=1 THEN json_extract(payload_json, '$.status') END"), "legacy JSON extraction must be structurally guarded");
assert.doesNotMatch(migration021, /json_valid(order_sync_outbox.payload_json)=1[\s\S]{0,80}AND json_extract/, "migration must not rely on AND short-circuiting for malformed JSON");
assert.ok(orderSync.includes("storedPayloadMatches(existing.payloadJson, event)"), "a matching metadata hash must not bypass payload validation");
assert.match(orderSync, /order_sync.payload_repaired/, "repairing the current payload must retain an audit record");
assert.match(media, /WAREHOUSE_MEDIA_CLAIM_LOST/, "expired media claims must be fenced from side effects");

console.log("PASS product archive and sync contract");
