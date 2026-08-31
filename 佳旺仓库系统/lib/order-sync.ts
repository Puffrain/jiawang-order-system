import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { integrationHeaders } from './integration-auth';
import type { ProductRecord } from './contracts/catalog';

type SaleStatus = 'active' | 'inactive';
type OrderProductEventType = 'warehouse.catalog.product.current';
type OutboxStatus = 'pending' | 'delivered' | 'dead' | 'superseded';
type AckDisposition = 'delivered' | 'superseded';

const EVENT_TYPE: OrderProductEventType = 'warehouse.catalog.product.current';
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface OrderProductVariant extends Record<string, unknown> {
  id: string;
  sku: string | null;
  barcodeRaw: string | null;
  barcodeNormalized: string | null;
  barcodeSymbology: ProductRecord['variants'][number]['barcodeSymbology'] | null;
  barcodeValid: boolean | null;
  specification: string;
  netContent: string | null;
  unit: string | null;
  packaging: string | null;
  color: string | null;
  scent: string | null;
  price: number | null;
  stock: number | null;
}

interface UnsignedOrderProductEvent extends Record<string, unknown> {
  id: string;
  eventType: OrderProductEventType;
  revision: number;
  mediaRevision: number;
  saleStatus: SaleStatus;
  category: string;
  categoryKey: string;
  subcategoryKey: string | null;
  categoryKeys: { category: string; subcategory: string | null };
  variants: OrderProductVariant[];
  publishedAssetIds: string[];
  name: string;
  brand: string | null;
  categoryId: string;
  subcategoryId: string | null;
  description: string | null;
  ingredients: string | null;
  efficacy: string | null;
  directions: string | null;
  warnings: string | null;
  countryOfOrigin: string | null;
  manufacturer: string | null;
  licenseNumber: string | null;
  batchNumber: string | null;
  productionDate: string | null;
  shelfLife: string | null;
  expiryDate: string | null;
  notes: string | null;
  sourceGroupId: string | null;
  entrySource: ProductRecord['entrySource'];
  status: ProductRecord['status'];
  reviewedAt: string | null;
  reviewedBy: string | null;
  publishedAt: string | null;
  everPublishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrderProductEvent extends UnsignedOrderProductEvent {
  payloadHash: string;
}

interface OutboxRow {
  id: string;
  product_id: string;
  revision: number;
  media_revision: number | null;
  payload_json: string;
  event_type: string | null;
  payload_hash: string | null;
  status: OutboxStatus;
  claim_token: string | null;
}

interface ExistingOutboxRow {
  id: string;
  eventType: string | null;
  mediaRevision: number | null;
  payloadHash: string | null;
  payloadJson: string;
  status: OutboxStatus;
}

type PayloadRepairReason =
  | 'invalid_json'
  | 'invalid_shape'
  | 'legacy_format'
  | 'identity_mismatch'
  | 'event_type_mismatch'
  | 'media_revision_mismatch'
  | 'payload_hash_invalid'
  | 'payload_hash_mismatch'
  | 'outbox_metadata_mismatch'
  | 'current_snapshot_mismatch';

function auditPayloadRepair(existing: ExistingOutboxRow, product: ProductRecord, timestamp: string, reason: PayloadRepairReason, newPayloadHash: string): void {
  getDb().prepare(`INSERT INTO audit_log(action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?)`)
    .run('order_sync.payload_repaired', 'order_sync_outbox', existing.id, JSON.stringify({
      productId: product.id,
      revision: product.revision,
      reason,
      previousStatus: existing.status,
      previousPayloadHash: createHash('sha256').update(existing.payloadJson).digest('hex'),
      newPayloadHash,
    }), timestamp);
}

function encodeCanonicalJson(value: unknown, arrayElement = false): string | undefined {
  if (Array.isArray(value)) {
    return '[' + value.map((item) => encodeCanonicalJson(item, true) ?? 'null').join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const properties: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const encoded = encodeCanonicalJson(source[key]);
      if (encoded !== undefined) properties.push(JSON.stringify(key) + ':' + encoded);
    }
    return '{' + properties.join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined && arrayElement ? 'null' : encoded;
}

/** Recursively key-sorted JSON. Arrays retain order and JSON keeps primitive semantics. */
export function canonicalJson(value: unknown): string {
  const encoded = encodeCanonicalJson(value);
  if (encoded === undefined) throw new Error('Canonical JSON root is not serializable');
  return encoded;
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function categoryProjection(product: ProductRecord): { category: string; categoryKey: string; subcategoryKey: string | null } {
  const db = getDb();
  const category = db.prepare('SELECT code, name FROM taxonomy_categories WHERE id = ?').get(product.categoryId) as { code: string; name: string } | undefined;
  const subcategory = product.subcategoryId
    ? db.prepare('SELECT code FROM taxonomy_categories WHERE id = ?').get(product.subcategoryId) as { code: string } | undefined
    : undefined;
  return {
    category: category?.name || product.categoryId,
    categoryKey: category?.code || product.categoryId,
    subcategoryKey: subcategory?.code || product.subcategoryId || null,
  };
}

function lifecycleProjection(productId: string): { everPublishedAt: string | null; archivedAt: string | null } {
  const row = getDb().prepare('SELECT ever_published_at everPublishedAt, archived_at archivedAt FROM products WHERE id = ?').get(productId) as { everPublishedAt: string | null; archivedAt: string | null } | undefined;
  if (!row) throw new Error('Order sync product lifecycle could not be loaded');
  return row;
}

function normalizeVariant(variant: ProductRecord['variants'][number]): OrderProductVariant {
  if (!variant.id?.trim()) throw new Error('Active order sync variants require stable IDs');
  if (!variant.specification?.trim()) throw new Error('Active order sync variants require specifications');
  if (variant.price != null && (!Number.isFinite(variant.price) || variant.price < 0)) throw new Error('Order sync variant price is invalid');
  if (variant.stock != null && (!Number.isSafeInteger(variant.stock) || variant.stock < 0)) throw new Error('Order sync variant stock is invalid');
  return {
    id: variant.id,
    sku: variant.sku ?? null,
    barcodeRaw: variant.barcodeRaw ?? null,
    barcodeNormalized: variant.barcodeNormalized ?? null,
    barcodeSymbology: variant.barcodeSymbology ?? null,
    barcodeValid: variant.barcodeValid ?? null,
    specification: variant.specification,
    netContent: variant.netContent ?? null,
    unit: variant.unit ?? null,
    packaging: variant.packaging ?? null,
    color: variant.color ?? null,
    scent: variant.scent ?? null,
    price: variant.price ?? null,
    stock: variant.stock ?? null,
  };
}

function buildOrderProductEvent(product: ProductRecord, saleStatus: SaleStatus, mediaRevision = product.revision): OrderProductEvent {
  if (!product.id || !Number.isSafeInteger(product.revision) || product.revision < 1) throw new Error('Invalid product revision for order sync');
  if (!Number.isSafeInteger(mediaRevision) || mediaRevision < 1) throw new Error('Invalid media revision for order sync');
  if (!product.name?.trim() || !product.categoryId?.trim()) throw new Error('Invalid product identity for order sync');

  const category = categoryProjection(product);
  const lifecycle = lifecycleProjection(product.id);
  const variants = saleStatus === 'active' ? product.variants.map(normalizeVariant) : [];
  if (saleStatus === 'active' && variants.length === 0) throw new Error('Active order sync event requires at least one SKU');
  const publishedAssetIds = saleStatus === 'active' ? [...(product.publishedAssetIds ?? [])] : [];
  if (publishedAssetIds.length > 8 || publishedAssetIds.some((id) => !id) || new Set(publishedAssetIds).size !== publishedAssetIds.length) {
    throw new Error('Order sync published assets are invalid');
  }

  const unsigned: UnsignedOrderProductEvent = {
    id: product.id,
    eventType: EVENT_TYPE,
    revision: product.revision,
    mediaRevision,
    saleStatus,
    category: category.category,
    categoryKey: category.categoryKey,
    subcategoryKey: category.subcategoryKey,
    categoryKeys: { category: category.categoryKey, subcategory: category.subcategoryKey },
    variants,
    publishedAssetIds,
    name: product.name,
    brand: product.brand ?? null,
    categoryId: product.categoryId,
    subcategoryId: product.subcategoryId ?? null,
    description: product.description ?? null,
    ingredients: product.ingredients ?? null,
    efficacy: product.efficacy ?? null,
    directions: product.directions ?? null,
    warnings: product.warnings ?? null,
    countryOfOrigin: product.countryOfOrigin ?? null,
    manufacturer: product.manufacturer ?? null,
    licenseNumber: product.licenseNumber ?? null,
    batchNumber: product.batchNumber ?? null,
    productionDate: product.productionDate ?? null,
    shelfLife: product.shelfLife ?? null,
    expiryDate: product.expiryDate ?? null,
    notes: product.notes ?? null,
    sourceGroupId: product.sourceGroupId ?? null,
    entrySource: product.entrySource,
    status: product.status,
    reviewedAt: product.reviewedAt ?? null,
    reviewedBy: product.reviewedBy ?? null,
    publishedAt: product.publishedAt ?? null,
    everPublishedAt: lifecycle.everPublishedAt,
    archivedAt: lifecycle.archivedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
  return { ...unsigned, payloadHash: hashPayload(unsigned) };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseStoredEvent(row: OutboxRow): OrderProductEvent {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { throw new Error('Order sync payload is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Order sync payload is not a JSON object');

  const legacyPayload = !hasOwn(parsed, 'eventType') || !hasOwn(parsed, 'payloadHash') || !hasOwn(parsed, 'mediaRevision');
  if (legacyPayload) {
    const legacy = parsed as unknown as ProductRecord;
    if (legacy.id !== row.product_id || legacy.revision !== row.revision) throw new Error('Legacy order sync payload identity mismatch');
    const legacySaleStatus: SaleStatus = parsed.saleStatus === 'active' || (!hasOwn(parsed, 'saleStatus') && legacy.status === 'published')
      ? 'active' : 'inactive';
    const upgraded = buildOrderProductEvent(legacy, legacySaleStatus);
    const updated = getDb().prepare(`UPDATE order_sync_outbox SET payload_json=?,event_type=?,media_revision=?,payload_hash=?,updated_at=? WHERE id=? AND status='pending'`)
      .run(canonicalJson(upgraded), upgraded.eventType, upgraded.mediaRevision, upgraded.payloadHash, new Date().toISOString(), row.id);
    if (updated.changes !== 1) throw new Error('Legacy order sync payload could not be upgraded');
    return upgraded;
  }

  const event = parsed as unknown as OrderProductEvent;
  const { payloadHash: suppliedHash, ...unsigned } = event;
  if (event.eventType !== EVENT_TYPE || event.id !== row.product_id || event.revision !== row.revision || !Number.isSafeInteger(event.revision) || event.revision < 1) throw new Error('Order sync payload identity mismatch');
  if (!Number.isSafeInteger(event.mediaRevision) || event.mediaRevision < 1) throw new Error('Order sync media revision is invalid');
  if (!HASH_PATTERN.test(suppliedHash) || hashPayload(unsigned) !== suppliedHash) throw new Error('Order sync payload hash mismatch');
  if (row.event_type && row.event_type !== event.eventType) throw new Error('Order sync event type mismatch');
  if (row.media_revision != null && row.media_revision !== event.mediaRevision) throw new Error('Order sync outbox media revision mismatch');
  if (row.payload_hash && row.payload_hash !== event.payloadHash) throw new Error('Order sync outbox hash mismatch');
  if (event.saleStatus !== 'active' && event.saleStatus !== 'inactive') throw new Error('Order sync sale status is invalid');
  if (!event.categoryKey || !event.categoryKeys || event.categoryKeys.category !== event.categoryKey || event.categoryKeys.subcategory !== event.subcategoryKey) throw new Error('Order sync category keys are invalid');
  if (!Array.isArray(event.publishedAssetIds) || !Array.isArray(event.variants)) throw new Error('Order sync collections are invalid');
  if (event.saleStatus === 'active' && event.variants.length === 0) throw new Error('Active order sync event requires at least one SKU');
  if (event.saleStatus === 'inactive' && (event.variants.length !== 0 || event.publishedAssetIds.length !== 0)) throw new Error('Inactive order sync event must be a zero-SKU tombstone');
  return event;
}

function payloadRepairReason(existing: ExistingOutboxRow, event: OrderProductEvent): PayloadRepairReason | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing.payloadJson) as Record<string, unknown>;
  } catch {
    return 'invalid_json';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid_shape';
  if (!hasOwn(parsed, 'eventType') || !hasOwn(parsed, 'payloadHash') || !hasOwn(parsed, 'mediaRevision')) return 'legacy_format';
  if (parsed.id !== event.id || parsed.revision !== event.revision || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 1) return 'identity_mismatch';
  if (parsed.eventType !== EVENT_TYPE) return 'event_type_mismatch';
  if (!Number.isSafeInteger(parsed.mediaRevision) || Number(parsed.mediaRevision) < 1 || parsed.mediaRevision !== event.mediaRevision) return 'media_revision_mismatch';
  if (typeof parsed.payloadHash !== 'string' || !HASH_PATTERN.test(parsed.payloadHash)) return 'payload_hash_invalid';
  const { payloadHash, ...unsigned } = parsed;
  if (hashPayload(unsigned) !== payloadHash) return 'payload_hash_mismatch';
  if ((existing.eventType != null && existing.eventType !== parsed.eventType)
    || (existing.mediaRevision != null && existing.mediaRevision !== parsed.mediaRevision)
    || (existing.payloadHash != null && existing.payloadHash !== payloadHash)) return 'outbox_metadata_mismatch';
  return payloadHash === event.payloadHash && canonicalJson(parsed) === canonicalJson(event) ? null : 'current_snapshot_mismatch';
}

function storedPayloadMatches(payloadJson: string, event: OrderProductEvent): boolean {
  try {
    const parsed = JSON.parse(payloadJson) as OrderProductEvent;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const { payloadHash, ...unsigned } = parsed;
    return parsed.id === event.id && parsed.revision === event.revision && payloadHash === event.payloadHash
      && HASH_PATTERN.test(payloadHash) && hashPayload(unsigned) === payloadHash;
  } catch {
    return false;
  }
}

function assertCurrentProductRevision(product: ProductRecord): void {
  const current = getDb().prepare('SELECT revision FROM products WHERE id=?').get(product.id) as { revision: number } | undefined;
  if (!current || current.revision !== product.revision) throw new Error('Only the current product revision can repair order sync payloads');
}

/** Persist one immutable current-state event for every catalog revision. */
export function enqueueOrderProduct(product: ProductRecord, saleStatus: SaleStatus = product.status === 'published' ? 'active' : 'inactive', mediaRevision = product.revision): void {
  const db = getDb();
  assertCurrentProductRevision(product);
  const event = buildOrderProductEvent(product, saleStatus, mediaRevision);
  const encoded = canonicalJson(event);
  const timestamp = new Date().toISOString();

  db.prepare(`UPDATE order_sync_outbox SET status='superseded',superseded_at=COALESCE(superseded_at,?),claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE product_id=? AND revision<? AND status IN ('pending','dead')`)
    .run(timestamp, timestamp, product.id, product.revision);

  const existing = db.prepare(`SELECT id,event_type eventType,media_revision mediaRevision,payload_hash payloadHash,payload_json payloadJson,status
    FROM order_sync_outbox WHERE product_id=? AND revision=?`).get(product.id, product.revision) as ExistingOutboxRow | undefined;
  if (existing) {
    if (existing.payloadHash === event.payloadHash && storedPayloadMatches(existing.payloadJson, event)
      && (existing.eventType == null || existing.eventType === event.eventType)
      && (existing.mediaRevision == null || existing.mediaRevision === event.mediaRevision)) {
      if (existing.eventType == null || existing.mediaRevision == null) {
        db.prepare('UPDATE order_sync_outbox SET event_type=?,media_revision=?,payload_hash=?,updated_at=? WHERE id=?')
          .run(event.eventType, event.mediaRevision, event.payloadHash, timestamp, existing.id);
      }
      return;
    }
    const repairReason = payloadRepairReason(existing, event);
    if ((existing.status !== 'pending' && existing.status !== 'dead') || !repairReason) throw new Error('Order sync revision payload is immutable');
    db.transaction(() => {
      auditPayloadRepair(existing, product, timestamp, repairReason, event.payloadHash);
      const updated = db.prepare(`UPDATE order_sync_outbox SET payload_json=?,event_type=?,media_revision=?,payload_hash=?,claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status IN ('pending','dead')`)
        .run(encoded, event.eventType, event.mediaRevision, event.payloadHash, timestamp, existing.id);
      if (updated.changes !== 1) throw new Error('Order sync revision payload could not be upgraded');
    })();
    return;
  }

  db.prepare(`INSERT INTO order_sync_outbox(id,product_id,revision,event_type,media_revision,payload_hash,payload_json,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), product.id, product.revision, event.eventType, event.mediaRevision, event.payloadHash, encoded, timestamp, timestamp, timestamp);
}

/** Reset only the current warehouse revision; historical rows remain auditable. */
export function replayCurrentOrderProduct(product: ProductRecord): void {
  enqueueOrderProduct(product);
  const timestamp = new Date().toISOString();
  const changed = getDb().prepare(`UPDATE order_sync_outbox SET status='pending',attempt_count=0,last_error=NULL,next_attempt_at=?,delivered_at=NULL,superseded_at=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE product_id=? AND revision=? AND status IN ('pending','dead')`)
    .run(timestamp, timestamp, product.id, product.revision);
  if (changed.changes !== 1) throw new Error('Only the current pending or dead order sync revision can be replayed');
}

/** ACKs are intentionally top-level. A stale ACK must echo the incoming event exactly. */
function assertDeliveryAcknowledgement(value: unknown, event: OrderProductEvent): AckDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Order sync acknowledgement must be a JSON object');
  const ack = value as Record<string, unknown>;
  if (ack.ok !== true || ack.eventType !== event.eventType || ack.warehouseProductId !== event.id
    || ack.revision !== event.revision || ack.payloadHash !== event.payloadHash
    || ack.saleStatus !== event.saleStatus || ack.status !== event.saleStatus) {
    throw new Error('Order sync acknowledgement does not match the delivered event');
  }
  if (typeof ack.productId !== 'string' || !ack.productId || typeof ack.mediaStatus !== 'string' || !ack.mediaStatus) {
    throw new Error('Order sync acknowledgement metadata is invalid');
  }
  if (ack.disposition === undefined || ack.disposition === 'applied' || ack.disposition === 'replayed') return 'delivered';
  if (ack.disposition === 'stale') return 'superseded';
  throw new Error('Order sync acknowledgement disposition is invalid');
}

function supersedeObsoleteOrderSyncRows(): void {
  const timestamp = new Date().toISOString();
  getDb().prepare(`UPDATE order_sync_outbox
    SET status='superseded',superseded_at=COALESCE(superseded_at,?),claim_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE status IN ('pending','dead')
      AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)
      AND EXISTS (SELECT 1 FROM order_sync_outbox newer WHERE newer.product_id=order_sync_outbox.product_id AND newer.revision>order_sync_outbox.revision)`)
    .run(timestamp, timestamp, timestamp);
}

function supersedeIfNewerRevisionExists(row: OutboxRow): boolean {
  const timestamp = new Date().toISOString();
  const changed = getDb().prepare(`UPDATE order_sync_outbox
    SET status='superseded',superseded_at=COALESCE(superseded_at,?),claim_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND status='pending' AND claim_token=? AND lease_expires_at>?
      AND EXISTS (SELECT 1 FROM order_sync_outbox newer WHERE newer.product_id=order_sync_outbox.product_id AND newer.revision>order_sync_outbox.revision)`)
    .run(timestamp, timestamp, row.id, row.claim_token, timestamp);
  return changed.changes === 1;
}

export async function processOrderSyncOutbox(limit = 20): Promise<number> {
  const base = process.env.ORDER_INTERNAL_URL?.replace(/\/+$/, '');
  if (!base) return 0;
  const path = '/api/internal/warehouse/products';
  supersedeObsoleteOrderSyncRows();
  const maxRows = Math.min(Math.max(Math.floor(limit), 1), 200);
  const claimNext = (): OutboxRow | null => {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    return getDb().transaction(() => {
      const candidate = getDb().prepare(`SELECT o.id,o.product_id,o.revision,o.media_revision,o.event_type,o.payload_hash,o.payload_json,o.status,o.claim_token
        FROM order_sync_outbox o
        WHERE o.status='pending' AND o.next_attempt_at<=?
          AND (o.claim_token IS NULL OR o.lease_expires_at IS NULL OR o.lease_expires_at<=?)
          AND NOT EXISTS (SELECT 1 FROM order_sync_outbox newer WHERE newer.product_id=o.product_id AND newer.revision>o.revision)
        ORDER BY o.created_at,o.product_id,o.revision LIMIT 1`).get(now, now) as OutboxRow | undefined;
      if (!candidate) return null;
      const token = randomUUID();
      const claimed = getDb().prepare(`UPDATE order_sync_outbox SET claim_token=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND status='pending' AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`)
        .run(token, leaseExpiresAt, now, candidate.id, now);
      return claimed.changes === 1 ? { ...candidate, claim_token: token } : null;
    }).immediate();
  };
  let delivered = 0;
  const ownsClaim = (row: OutboxRow): boolean => {
    const current = getDb().prepare(`SELECT 1 FROM order_sync_outbox
      WHERE id=? AND status='pending' AND claim_token=? AND lease_expires_at>?`).get(row.id, row.claim_token, new Date().toISOString());
    return Boolean(current);
  };

  for (let processed = 0; processed < maxRows; processed += 1) {
    const row = claimNext();
    if (!row) break;
    if (supersedeIfNewerRevisionExists(row)) continue;
    try {
      const event = parseStoredEvent(row);
      if (supersedeIfNewerRevisionExists(row)) continue;
      if (!ownsClaim(row)) continue;
      const body = canonicalJson(event);
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: integrationHeaders('POST', path, body, randomUUID()),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) throw new Error('Order sync acknowledgement is not JSON');
      const responseBody = await response.text();
      if (responseBody.length > 32_000) throw new Error('Order sync acknowledgement is too large');
      let acknowledgement: unknown;
      try { acknowledgement = JSON.parse(responseBody); } catch { throw new Error('Order sync acknowledgement is invalid JSON'); }
      const disposition = assertDeliveryAcknowledgement(acknowledgement, event);
      const timestamp = new Date().toISOString();
      const changed = disposition === 'delivered'
        ? getDb().prepare(`UPDATE order_sync_outbox SET status='delivered',delivered_at=?,last_error=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='pending' AND claim_token=? AND lease_expires_at>?`).run(timestamp, timestamp, row.id, row.claim_token, timestamp)
        : getDb().prepare(`UPDATE order_sync_outbox SET status='superseded',superseded_at=COALESCE(superseded_at,?),last_error=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='pending' AND claim_token=? AND lease_expires_at>?`).run(timestamp, timestamp, row.id, row.claim_token, timestamp);
      if (disposition === 'delivered' && changed.changes === 1) delivered += 1;
    } catch (error) {
      if (supersedeIfNewerRevisionExists(row)) continue;
      const failureTimestamp = new Date().toISOString();
      const current = getDb().prepare('SELECT attempt_count,status,claim_token claimToken,lease_expires_at leaseExpiresAt FROM order_sync_outbox WHERE id=?').get(row.id) as { attempt_count: number; status: OutboxStatus; claimToken: string | null; leaseExpiresAt: string | null } | undefined;
      if (!current || current.status !== 'pending' || current.claimToken !== row.claim_token || !current.leaseExpiresAt || current.leaseExpiresAt <= failureTimestamp) continue;
      const attempts = current.attempt_count + 1;
      const dead = attempts >= 12;
      getDb().prepare(`UPDATE order_sync_outbox SET status=?,attempt_count=?,next_attempt_at=?,last_error=?,claim_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='pending' AND claim_token=? AND lease_expires_at>?`).run(
        dead ? 'dead' : 'pending', attempts,
        new Date(Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 10))).toISOString(),
        error instanceof Error ? error.message.slice(0, 300) : 'delivery failed',
        failureTimestamp, row.id, row.claim_token, failureTimestamp,
      );
    }
  }
  return delivered;
}
