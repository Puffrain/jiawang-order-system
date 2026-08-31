import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.join(process.cwd(), ".task-runs", `warehouse-projection-${Date.now()}`);
fs.mkdirSync(runtimeDir, { recursive: true });
process.env.DATABASE_URL = `file:${path.join(runtimeDir, "app.db")}`;
process.env.UPLOAD_DIR = path.join(runtimeDir, "uploads");
process.env.SEED_SAMPLE_PRODUCTS = "false";
process.env.INTEGRATION_SHARED_SECRET = "runtime-integration-secret-at-least-32-characters";

const db = (await import("../../lib/db")).default;
const { integrationHeaders } = await import("../../lib/integration-auth");
const { POST } = await import("../../app/api/internal/warehouse/products/route");
const { queueWarehouseProductMedia, claimPendingWarehouseMedia } = await import("../../lib/warehouse-product-media");
const { setWarehouseSkuPriceOverride } = await import("../../lib/product-catalog");
const { listProducts } = await import("../../lib/product-catalog");

type EventInput = {
  revision: number;
  mediaRevision?: number;
  saleStatus?: "active" | "inactive";
  price?: number;
  stock?: number;
  assets?: string[];
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return "{" + Object.keys(source).sort().filter((key) => source[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(source[key])).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported canonical value");
  return encoded;
}

function event(input: EventInput) {
  const saleStatus = input.saleStatus ?? "active";
  const unsigned = {
    id: "warehouse-runtime-product",
    eventType: "warehouse.catalog.product.current",
    revision: input.revision,
    mediaRevision: input.mediaRevision ?? input.revision,
    saleStatus,
    name: "Runtime Product",
    brand: "Runtime Brand",
    category: "Hair",
    categoryId: "category-hair",
    categoryKey: "hair",
    subcategoryKey: "hair-color",
    categoryKeys: { category: "hair", subcategory: "hair-color" },
    description: "warehouse description",
    publishedAssetIds: saleStatus === "active" ? (input.assets ?? ["asset-v1"]) : [],
    variants: saleStatus === "active" ? [{
      id: "warehouse-runtime-variant",
      sku: "RUNTIME-WH-1",
      barcodeNormalized: null,
      specification: "500ml",
      price: input.price ?? 12.5,
      stock: input.stock ?? 10,
    }] : [],
  };
  return { ...unsigned, payloadHash: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") };
}

async function project(payload: ReturnType<typeof event>) {
  const body = JSON.stringify(payload);
  const pathname = "/api/internal/warehouse/products";
  const request = new Request(`http://order.test${pathname}`, {
    method: "POST",
    headers: integrationHeaders("POST", pathname, body, randomUUID()),
    body,
  });
  const response = await POST(request);
  return { response, json: await response.json() as Record<string, unknown> };
}

try {
  const first = await project(event({ revision: 1, price: 12.5, stock: 10 }));
  assert.equal(first.response.status, 200);
  assert.equal(first.json.disposition, "applied");
  const productId = String(first.json.productId);
  let product = db.prepare("SELECT status,warehouse_revision revision,warehouse_payload_hash payloadHash FROM products WHERE id=?").get(productId) as {status:string;revision:number;payloadHash:string};
  assert.equal(product.status, "active");
  assert.equal(product.revision, 1);

  const replay = await project(event({ revision: 1, price: 12.5, stock: 10 }));
  assert.equal(replay.response.status, 200);
  assert.equal(replay.json.disposition, "replayed");

  const conflict = await project(event({ revision: 1, price: 99, stock: 10 }));
  assert.equal(conflict.response.status, 409);
  product = db.prepare("SELECT status,warehouse_revision revision,warehouse_payload_hash payloadHash FROM products WHERE id=?").get(productId) as typeof product;
  assert.equal(product.revision, 1);
  assert.equal(product.payloadHash, event({ revision: 1, price: 12.5, stock: 10 }).payloadHash);

  const sku = db.prepare("SELECT id FROM product_skus WHERE product_id=?").get(productId) as {id:string};
  setWarehouseSkuPriceOverride(productId, sku.id, 18.8);
  const updated = await project(event({ revision: 2, price: 13.5, stock: 8, assets: ["asset-v2"] }));
  assert.equal(updated.response.status, 200);
  const price = listProducts("buyer").find((item) => item.id === productId)?.skus.find((item) => item.id === sku.id);
  assert.deepEqual(price && { warehouseBasePrice: price.warehouseBasePrice, salePriceOverride: price.salePriceOverride, basePrice: price.basePrice, stock: price.stock },
    { warehouseBasePrice: 13.5, salePriceOverride: 18.8, basePrice: 18.8, stock: 8 });

  queueWarehouseProductMedia(productId, "warehouse-runtime-product", 1, 1, ["stale-asset"]);
  const media = db.prepare("SELECT warehouse_revision revision,media_revision mediaRevision,asset_ids_json assets FROM warehouse_media_sync WHERE product_id=?").get(productId) as {revision:number;mediaRevision:number;assets:string};
  assert.equal(media.revision, 2);
  assert.equal(media.mediaRevision, 2);
  assert.deepEqual(JSON.parse(media.assets), ["asset-v2"]);
  const firstClaim = claimPendingWarehouseMedia(1);
  const secondClaim = claimPendingWarehouseMedia(1);
  assert.equal(firstClaim.length, 1);
  assert.equal(secondClaim.length, 0, "an active lease must prevent a concurrent claim");

  const tombstone = await project(event({ revision: 3, saleStatus: "inactive", mediaRevision: 3 }));
  assert.equal(tombstone.response.status, 200);
  assert.equal(tombstone.json.saleStatus, "inactive");
  assert.equal((db.prepare("SELECT status FROM products WHERE id=?").get(productId) as {status:string}).status, "inactive");
  assert.ok((db.prepare("SELECT archived_at archivedAt FROM product_skus WHERE id=?").get(sku.id) as {archivedAt:string|null}).archivedAt);

  const stale = await project(event({ revision: 2, price: 13.5, stock: 8, assets: ["asset-v2"] }));
  assert.equal(stale.response.status, 200);
  assert.equal(stale.json.disposition, "stale");
  assert.equal((db.prepare("SELECT status FROM products WHERE id=?").get(productId) as {status:string}).status, "inactive");

  db.prepare("UPDATE products SET permanently_hidden_at=CURRENT_TIMESTAMP,archived_at=CURRENT_TIMESTAMP WHERE id=?").run(productId);
  const revived = await project(event({ revision: 4, price: 14.5, stock: 6, assets: ["asset-v4"] }));
  assert.equal(revived.response.status, 200);
  const revival = db.prepare("SELECT status,archived_at archivedAt,permanently_hidden_at hiddenAt,warehouse_revision revision FROM products WHERE id=?").get(productId) as {status:string;archivedAt:string|null;hiddenAt:string|null;revision:number};
  assert.deepEqual(revival, { status: "active", archivedAt: null, hiddenAt: null, revision: 4 });
  const revivedPrice = listProducts("buyer").find((item) => item.id === productId)?.skus.find((item) => item.id === sku.id);
  assert.deepEqual(revivedPrice && { warehouseBasePrice: revivedPrice.warehouseBasePrice, salePriceOverride: revivedPrice.salePriceOverride, basePrice: revivedPrice.basePrice },
    { warehouseBasePrice: 14.5, salePriceOverride: 18.8, basePrice: 18.8 });

  setWarehouseSkuPriceOverride(productId, sku.id, null);
  const restored = listProducts("buyer").find((item) => item.id === productId)?.skus.find((item) => item.id === sku.id);
  assert.deepEqual(restored && { warehouseBasePrice: restored.warehouseBasePrice, salePriceOverride: restored.salePriceOverride, basePrice: restored.basePrice },
    { warehouseBasePrice: 14.5, salePriceOverride: null, basePrice: 14.5 });

  console.log("warehouse product projection runtime: PASS");
} finally {
  db.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
