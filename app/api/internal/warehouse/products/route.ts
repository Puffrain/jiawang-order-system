import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { verifyIntegrationRequest } from "@/lib/integration-auth";
import { queueWarehouseProductMedia } from "@/lib/warehouse-product-media";

const EVENT_TYPE = "warehouse.catalog.product.current";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_VARIANTS = 500;
const MAX_ASSETS = 8;

type SaleStatus = "active" | "inactive";

type Variant = {
  id: string;
  sku?: string | null;
  barcodeNormalized?: string | null;
  specification: string;
  price?: number | null;
  stock?: number | null;
};

type WarehouseProductEvent = {
  id: string;
  eventType: typeof EVENT_TYPE;
  revision: number;
  mediaRevision: number;
  saleStatus: SaleStatus;
  name: string;
  brand?: string | null;
  category: string;
  categoryId?: string | null;
  categoryKey: string;
  subcategoryKey: string | null;
  categoryKeys: { category: string; subcategory: string | null };
  description?: string | null;
  publishedAssetIds: string[];
  variants: Variant[];
  payloadHash: string;
};

type ExistingProjection = {
  id: string;
  revision: number | null;
  payloadHash: string | null;
  mediaRevision: number | null;
};

type ProjectionOutcome = {
  kind: "applied" | "replayed" | "stale";
  productId: string;
  mediaStatus: "pending" | "not_required" | "unchanged";
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = canonicalValue(source[key]);
    }
    return sorted;
  }
  return value;
}

// Keep this compatible with the warehouse outbox canonical JSON implementation.
function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) throw new Error("event is not serializable");
  return encoded;
}

function canonicalPayloadHash(event: WarehouseProductEvent): string {
  const { payloadHash: _payloadHash, ...unsigned } = event;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function stable(prefix: string, value: string) {
  return prefix + "-" + createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function proposedSku(variant: Variant) {
  const fallback = "WH-" + createHash("sha256").update(variant.id).digest("hex").slice(0, 16);
  return String(variant.sku || variant.barcodeNormalized || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9._/-]/g, "-")
    .slice(0, 64);
}

function availableSku(variant: Variant, skuId: string) {
  const proposed = proposedSku(variant);
  const collision = db.prepare("SELECT id FROM product_skus WHERE sku_code=? AND id<>?").get(proposed, skuId);
  return collision ? "WH-" + createHash("sha256").update(variant.id).digest("hex").slice(0, 20).toUpperCase() : proposed;
}

function text(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}

function optionalText(value: unknown, max: number) {
  return value === undefined || value === null || text(value, max);
}

function parsePayload(raw: string): { body?: WarehouseProductEvent; error?: string } {
  let body: WarehouseProductEvent;
  try {
    body = JSON.parse(raw) as WarehouseProductEvent;
  } catch {
    return { error: "invalid json" };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid event" };
  if (body.eventType !== EVENT_TYPE || !text(body.id, 160, true) || !text(body.name, 120, true)
    || !text(body.category, 120, true) || !text(body.categoryKey, 160, true)
    || !Number.isSafeInteger(body.revision) || body.revision < 1
    || !Number.isSafeInteger(body.mediaRevision) || body.mediaRevision < 1
    || (body.saleStatus !== "active" && body.saleStatus !== "inactive")
    || !HASH_PATTERN.test(body.payloadHash || "")) {
    return { error: "invalid product event" };
  }
  if (!optionalText(body.brand, 60) || !optionalText(body.description, 3_000)
    || !optionalText(body.categoryId, 160)
    || !(body.subcategoryKey === null || text(body.subcategoryKey, 160, true))
    || !body.categoryKeys || typeof body.categoryKeys !== "object"
    || body.categoryKeys.category !== body.categoryKey
    || body.categoryKeys.subcategory !== body.subcategoryKey) {
    return { error: "invalid product metadata" };
  }
  if (!Array.isArray(body.variants) || body.variants.length > MAX_VARIANTS
    || !Array.isArray(body.publishedAssetIds) || body.publishedAssetIds.length > MAX_ASSETS
    || body.publishedAssetIds.some((assetId) => !text(assetId, 240, true))
    || new Set(body.publishedAssetIds).size !== body.publishedAssetIds.length) {
    return { error: "invalid product collections" };
  }
  if (body.saleStatus === "active" && body.variants.length === 0) return { error: "active event requires variants" };
  if (body.saleStatus === "inactive" && (body.variants.length !== 0 || body.publishedAssetIds.length !== 0)) {
    return { error: "inactive event must be a zero-SKU tombstone" };
  }

  const variantIds = new Set<string>();
  for (const variant of body.variants) {
    if (!variant || typeof variant !== "object" || !text(variant.id, 160, true) || variantIds.has(variant.id)
      || !text(variant.specification, 100, true) || !optionalText(variant.sku, 64) || !optionalText(variant.barcodeNormalized, 160)) {
      return { error: "invalid variant" };
    }
    if (variant.price !== undefined && variant.price !== null && (!Number.isFinite(variant.price) || variant.price < 0 || variant.price > 100_000_000)) {
      return { error: "invalid variant price" };
    }
    if (variant.stock !== undefined && variant.stock !== null && (!Number.isSafeInteger(variant.stock) || variant.stock < 0 || variant.stock > 10_000_000)) {
      return { error: "invalid variant stock" };
    }
    variantIds.add(variant.id);
  }

  try {
    if (canonicalPayloadHash(body) !== body.payloadHash) return { error: "payload hash mismatch" };
  } catch {
    return { error: "invalid payload hash" };
  }
  return { body };
}

function audit(action: string, warehouseProductId: string, metadata: Record<string, unknown>) {
  writeAudit({
    actorRole: "system",
    action,
    objectType: "warehouse_product",
    objectId: warehouseProductId,
    metadata,
  });
}

function acknowledgment(event: WarehouseProductEvent, result: ProjectionOutcome) {
  return {
    ok: true,
    eventType: event.eventType,
    warehouseProductId: event.id,
    revision: event.revision,
    payloadHash: event.payloadHash,
    saleStatus: event.saleStatus,
    status: event.saleStatus,
    productId: result.productId,
    mediaStatus: result.mediaStatus,
    disposition: result.kind,
  };
}

export async function POST(request: Request) {
  const raw = await request.text();
  try {
    if (!verifyIntegrationRequest(request, raw)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "integration unavailable" }, { status: 503 });
  }

  const parsed = parsePayload(raw);
  if (!parsed.body) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const event = parsed.body;

  try {
    const result = db.transaction((): ProjectionOutcome => {
      const existing = db.prepare("SELECT id,warehouse_revision revision,warehouse_payload_hash payloadHash,warehouse_media_revision mediaRevision FROM products WHERE warehouse_product_id=?")
        .get(event.id) as ExistingProjection | undefined;

      if (existing && Number(existing.revision) > event.revision) {
        audit("warehouse.product_sync.stale_ignored", event.id, { productId: existing.id, incomingRevision: event.revision, currentRevision: existing.revision });
        return { kind: "stale", productId: existing.id, mediaStatus: "unchanged" };
      }
      if (existing && Number(existing.revision) === event.revision && existing.payloadHash) {
        if (existing.payloadHash !== event.payloadHash) {
          audit("warehouse.product_sync.revision_conflict", event.id, { productId: existing.id, revision: event.revision });
          throw new Error("WAREHOUSE_REVISION_PAYLOAD_CONFLICT");
        }
        if (event.saleStatus === "active") queueWarehouseProductMedia(existing.id, event.id, event.revision, event.mediaRevision, event.publishedAssetIds);
        audit("warehouse.product_sync.replayed", event.id, { productId: existing.id, revision: event.revision });
        return { kind: "replayed", productId: existing.id, mediaStatus: event.saleStatus === "active" ? "pending" : "not_required" };
      }
      if (existing && existing.mediaRevision !== null && event.mediaRevision < existing.mediaRevision) {
        audit("warehouse.product_sync.media_revision_conflict", event.id, { productId: existing.id, revision: event.revision, mediaRevision: event.mediaRevision, currentMediaRevision: existing.mediaRevision });
        throw new Error("WAREHOUSE_MEDIA_REVISION_REGRESSION");
      }

      const productId = existing?.id || stable("whp", event.id);
      const category = event.category.trim().slice(0, 60);
      const name = event.name.trim().slice(0, 120);
      const brand = event.brand?.trim().slice(0, 60) || null;
      const shouldRevive = event.saleStatus === "active" ? 1 : 0;

      if (existing) {
        // Local sales copy belongs to the merchant; warehouse owns canonical product fields.
        db.prepare("UPDATE products SET name=?,category=?,category_key=?,subcategory_key=?,brand=?,status=?,warehouse_revision=?,warehouse_payload_hash=?,warehouse_sale_status=?,warehouse_media_revision=?,archived_at=CASE WHEN ?=1 THEN NULL ELSE archived_at END,permanently_hidden_at=CASE WHEN ?=1 THEN NULL ELSE permanently_hidden_at END,status_before_archive=CASE WHEN ?=1 THEN NULL ELSE status_before_archive END,first_activated_at=CASE WHEN ?='active' THEN COALESCE(first_activated_at,CURRENT_TIMESTAMP) ELSE first_activated_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(name, category, event.categoryKey, event.subcategoryKey, brand, event.saleStatus, event.revision, event.payloadHash, event.saleStatus, event.mediaRevision, shouldRevive, shouldRevive, shouldRevive, event.saleStatus, productId);
      } else {
        db.prepare("INSERT INTO products(id,name,category,category_key,subcategory_key,brand,description,status,warehouse_product_id,warehouse_revision,warehouse_payload_hash,warehouse_sale_status,warehouse_media_revision,first_activated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='active' THEN CURRENT_TIMESTAMP END)")
          .run(productId, name, category, event.categoryKey, event.subcategoryKey, brand, event.description?.slice(0, 3_000) || null, event.saleStatus, event.id, event.revision, event.payloadHash, event.saleStatus, event.mediaRevision, event.saleStatus);
      }

      const liveSkuIds = new Set<string>();
      for (const variant of event.variants) {
        const found = db.prepare("SELECT id,product_id productId FROM product_skus WHERE warehouse_variant_id=?").get(variant.id) as { id: string; productId: string } | undefined;
        if (found && found.productId !== productId) throw new Error("WAREHOUSE_VARIANT_OWNERSHIP_CONFLICT");
        const skuId = found?.id || stable("whs", variant.id);
        const warehousePrice = Number(variant.price ?? 0);
        const warehouseStock = Number(variant.stock ?? 0);
        const skuCode = availableSku(variant, skuId);
        liveSkuIds.add(skuId);

        if (found) {
          // A merchant price override remains effective until explicitly reset.
          db.prepare("UPDATE product_skus SET sku_code=?,spec_name=?,warehouse_base_price=?,base_price=CASE WHEN sale_price_override IS NULL THEN ? ELSE base_price END,stock=?,archived_at=NULL,archived_by_product=0,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(skuCode, variant.specification.trim().slice(0, 100), warehousePrice, warehousePrice, warehouseStock, skuId);
        } else {
          db.prepare("INSERT INTO product_skus(id,product_id,sku_code,spec_name,base_price,warehouse_base_price,stock,warehouse_variant_id) VALUES(?,?,?,?,?,?,?,?)")
            .run(skuId, productId, skuCode, variant.specification.trim().slice(0, 100), warehousePrice, warehousePrice, warehouseStock, variant.id);
        }
      }

      const obsoleteSkus = db.prepare("SELECT id FROM product_skus WHERE product_id=? AND warehouse_variant_id IS NOT NULL").all(productId) as Array<{ id: string }>;
      for (const sku of obsoleteSkus) {
        if (!liveSkuIds.has(sku.id)) {
          db.prepare("UPDATE product_skus SET archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP),archived_by_product=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(event.saleStatus === "inactive" ? 1 : 0, sku.id);
        }
      }

      if (event.saleStatus === "active") queueWarehouseProductMedia(productId, event.id, event.revision, event.mediaRevision, event.publishedAssetIds);
      audit(existing && existing.payloadHash === null ? "warehouse.product_sync.legacy_reconciled" : "warehouse.product_sync.applied", event.id, {
        productId,
        revision: event.revision,
        saleStatus: event.saleStatus,
        mediaRevision: event.mediaRevision,
        skuCount: event.variants.length,
      });
      return { kind: "applied", productId, mediaStatus: event.saleStatus === "active" ? "pending" : "not_required" };
    }).immediate();

    return NextResponse.json(acknowledgment(event, result));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "WAREHOUSE_PRODUCT_SYNC_FAILED";
    if (["WAREHOUSE_REVISION_PAYLOAD_CONFLICT", "WAREHOUSE_MEDIA_REVISION_REGRESSION", "WAREHOUSE_VARIANT_OWNERSHIP_CONFLICT"].includes(detail)) {
      try { audit("warehouse.product_sync.conflict", event.id, { revision: event.revision, mediaRevision: event.mediaRevision, code: detail }); } catch { /* keep the protocol error authoritative */ }
    }
    const status = detail === "WAREHOUSE_REVISION_PAYLOAD_CONFLICT" || detail === "WAREHOUSE_MEDIA_REVISION_REGRESSION" || detail === "WAREHOUSE_VARIANT_OWNERSHIP_CONFLICT" ? 409 : 500;
    return NextResponse.json({ error: "product sync failed", code: detail }, { status });
  }
}
