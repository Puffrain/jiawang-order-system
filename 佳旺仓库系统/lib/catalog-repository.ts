import { randomUUID } from 'node:crypto';
import { getDb, withTransaction, type SqliteDatabase } from './db';
import { normalizeBarcode } from './barcode';
import { enqueueOrderProduct } from './order-sync';
import { recordAuditWithDb, type AuditEvent } from './audit';
import { validateForPublish, type BeautyProductInput, type CategoryRecord, type ProductRecord, type ProductStatus, type ProductVariantInput } from './contracts/catalog';
import { withWriteLeaseSync } from './maintenance';

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  category_id: string;
  subcategory_id: string | null;
  description: string | null;
  ingredients: string | null;
  efficacy: string | null;
  directions: string | null;
  warnings: string | null;
  country_of_origin: string | null;
  manufacturer: string | null;
  license_number: string | null;
  batch_number: string | null;
  production_date: string | null;
  shelf_life: string | null;
  expiry_date: string | null;
  notes: string | null;
  source_group_id: string | null;
  entry_source: ProductRecord['entrySource'];
  status: ProductStatus;
  revision: number;
  reviewed_at: string | null;
  reviewed_by: string | null;
  published_at: string | null;
  ever_published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string | null;
  barcode_raw: string | null;
  barcode_normalized: string | null;
  barcode_symbology: ProductVariantInput['barcodeSymbology'];
  barcode_valid: number | null;
  specification: string;
  net_content: string | null;
  unit: string | null;
  packaging: string | null;
  color: string | null;
  scent: string | null;
  price: number | null;
  stock: number | null;
}

export interface ProductListOptions {
  status?: ProductStatus | 'all';
  search?: string;
  categoryId?: string;
  limit?: number;
  offset?: number;
}

function now(): string { return new Date().toISOString(); }
function clean(value: unknown, max = 10_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}
function asNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function mapVariant(row: VariantRow): ProductVariantInput & { id: string } {
  return {
    id: row.id,
    sku: row.sku,
    barcodeRaw: row.barcode_raw,
    barcodeNormalized: row.barcode_normalized,
    barcodeSymbology: row.barcode_symbology,
    barcodeValid: row.barcode_valid == null ? null : row.barcode_valid === 1,
    specification: row.specification,
    netContent: row.net_content,
    unit: row.unit,
    packaging: row.packaging,
    color: row.color,
    scent: row.scent,
    price: row.price,
    stock: row.stock,
  };
}

function mapProduct(row: ProductRow, variants: VariantRow[]): ProductRecord {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    description: row.description,
    ingredients: row.ingredients,
    efficacy: row.efficacy,
    directions: row.directions,
    warnings: row.warnings,
    countryOfOrigin: row.country_of_origin,
    manufacturer: row.manufacturer,
    licenseNumber: row.license_number,
    batchNumber: row.batch_number,
    productionDate: row.production_date,
    shelfLife: row.shelf_life,
    expiryDate: row.expiry_date,
    notes: row.notes,
    variants: variants.map(mapVariant),
    sourceGroupId: row.source_group_id,
    entrySource: row.entry_source,
    status: row.status,
    revision: row.revision,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function variantsFor(db: SqliteDatabase, productIds: string[]): Map<string, VariantRow[]> {
  const result = new Map<string, VariantRow[]>();
  if (!productIds.length) return result;
  const placeholders = productIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM product_variants WHERE deleted_at IS NULL AND product_id IN (${placeholders}) ORDER BY created_at ASC`).all(...productIds) as VariantRow[];
  for (const row of rows) {
    const list = result.get(row.product_id) ?? [];
    list.push(row);
    result.set(row.product_id, list);
  }
  return result;
}

function productRows(db: SqliteDatabase, options: ProductListOptions): ProductRow[] {
  const where: string[] = ['p.archived_at IS NULL'];
  const params: unknown[] = [];
  if (options.status && options.status !== 'all') { where.push('p.status = ?'); params.push(options.status); }
  if (options.categoryId) { where.push('p.category_id = ?'); params.push(options.categoryId); }
  if (options.search?.trim()) {
    const query = `%${options.search.trim().slice(0, 100)}%`;
    where.push('(p.name LIKE ? OR COALESCE(p.brand, \'\') LIKE ? OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND sv.deleted_at IS NULL AND (COALESCE(sv.sku, \'\') LIKE ? OR COALESCE(sv.barcode_normalized, \'\') LIKE ?)))');
    params.push(query, query, query, query);
  }
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 500);
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);
  return db.prepare(`SELECT p.* FROM products p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as ProductRow[];
}

export function listCategories(includeInactive = false): CategoryRecord[] {
  const where = includeInactive ? '' : 'WHERE active = 1';
  const rows = getDb().prepare(`SELECT id, code, name, parent_id AS parentId, active, sort_order AS sortOrder FROM taxonomy_categories ${where} ORDER BY sort_order, name`).all() as Array<{ id: string; code: string; name: string; parentId: string | null; active: number; sortOrder: number }>;
  return rows.map((row) => ({ ...row, active: Boolean(row.active) }));
}

export function saveCategory(input: { id?: string; code: string; name: string; parentId?: string | null; active?: boolean; sortOrder?: number }): CategoryRecord {
  const code = clean(input.code, 64)?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const name = clean(input.name, 120);
  if (!code || !name) throw new Error('分类编码和名称不能为空');
  if (input.id && input.parentId === input.id) throw new Error('分类不能以自己为父级');
  const id = input.id ?? `cat-${randomUUID()}`;
  if (id === 'cat-pending' && (code !== 'pending' || input.parentId || input.active === false)) throw new Error('待定类目是系统保留类目，编码、层级和状态不能修改');
  if (id !== 'cat-pending' && code === 'pending') throw new Error('pending 编码由系统保留');
  if (code === 'pending' && input.active === false) throw new Error('待定分类不能停用');
  const timestamp = now();
  withTransaction((db) => {
    if (input.parentId) {
      const parent = db.prepare('SELECT id, active FROM taxonomy_categories WHERE id = ?').get(input.parentId) as { id: string; active: number } | undefined;
      if (!parent || parent.active !== 1) throw new Error('父级分类不存在或已停用');
    }
    db.prepare(`INSERT INTO taxonomy_categories (id, code, name, parent_id, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, parent_id=excluded.parent_id, active=excluded.active, sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
      .run(id, code, name, input.parentId ?? null, input.active === false ? 0 : 1, Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 0, timestamp, timestamp);
  });
  return listCategories(true).find((category) => category.id === id)!;
}

export class CategoryDeleteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'CategoryDeleteError';
    this.code = code;
    this.status = status;
  }
}

export function deleteCategory(id: string, auditEvent?: AuditEvent): void {
  withTransaction((db) => {
    const category = db.prepare('SELECT id, code FROM taxonomy_categories WHERE id = ?').get(id) as { id: string; code: string } | undefined;
    if (!category) throw new CategoryDeleteError('CATEGORY_NOT_FOUND', '类目不存在', 404);
    if (category.id === 'cat-pending' || category.code === 'pending') throw new CategoryDeleteError('CATEGORY_PROTECTED', '待定类目是系统保留类目，不能删除');

    const children = db.prepare('SELECT COUNT(*) count FROM taxonomy_categories WHERE parent_id = ?').get(id) as { count: number };
    const products = db.prepare('SELECT COUNT(*) count FROM products WHERE category_id = ? OR subcategory_id = ?').get(id, id) as { count: number };
    const groups = db.prepare('SELECT COUNT(*) count FROM candidate_groups WHERE category_id = ?').get(id) as { count: number };
    if (children.count > 0 || products.count > 0 || groups.count > 0) {
      throw new CategoryDeleteError(
        'CATEGORY_IN_USE',
        `类目仍被使用（子类目 ${children.count}、商品 ${products.count}、候选分组 ${groups.count}），请先处理关联数据`,
      );
    }

    db.prepare('DELETE FROM taxonomy_categories WHERE id = ?').run(id);
    if (auditEvent) recordAuditWithDb(db, auditEvent);
  });
}

export function listProducts(options: ProductListOptions = {}): { products: ProductRecord[]; total: number } {
  const db = getDb();
  const rows = productRows(db, options);
  const variants = variantsFor(db, rows.map((row) => row.id));
  const media = productMedia(db, rows.map((row) => row.id));
  const syncRows = rows.length ? db.prepare(`SELECT o.product_id productId,o.status,o.attempt_count attempts,o.last_error error FROM order_sync_outbox o JOIN (SELECT product_id,MAX(revision) revision FROM order_sync_outbox WHERE product_id IN (${rows.map(() => '?').join(',')}) GROUP BY product_id) latest ON latest.product_id=o.product_id AND latest.revision=o.revision`).all(...rows.map((row) => row.id)) as Array<{productId:string;status:'pending'|'delivered'|'dead'|'superseded';attempts:number;error:string|null}> : [];
  const sync = new Map(syncRows.map((row) => [row.productId, row]));
  const products = rows.map((row) => { const state=sync.get(row.id); const orderSyncStatus=state?.status === 'superseded' ? null : state?.status ?? null; return ({ ...mapProduct(row, variants.get(row.id) ?? []), ...(media.get(row.id) || {}), orderSyncStatus,orderSyncAttempts:state?.attempts??0,orderSyncError:state?.error??null }); });
  const where: string[] = ['archived_at IS NULL'];
  const params: unknown[] = [];
  if (options.status && options.status !== 'all') { where.push('status = ?'); params.push(options.status); }
  if (options.categoryId) { where.push('category_id = ?'); params.push(options.categoryId); }
  if (options.search?.trim()) {
    const query = `%${options.search.trim().slice(0, 100)}%`;
    where.push('(name LIKE ? OR COALESCE(brand, \'\') LIKE ? OR id IN (SELECT product_id FROM product_variants WHERE deleted_at IS NULL AND (COALESCE(sku, \'\') LIKE ? OR COALESCE(barcode_normalized, \'\') LIKE ?)))');
    params.push(query, query, query, query);
  }
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...params) as { count: number };
  const total = Number(countRow.count);
  return { products, total };
}

function getProduct(id: string, includeArchived = false): ProductRecord | null {
  const db = getDb();
  const row = db.prepare(includeArchived ? 'SELECT * FROM products WHERE id = ?' : 'SELECT * FROM products WHERE id = ? AND archived_at IS NULL').get(id) as ProductRow | undefined;
  if (!row) return null;
  const map = variantsFor(db, [id]);
  return { ...mapProduct(row, map.get(id) ?? []), ...(productMedia(db, [id]).get(id) || {}) };
}

export { getProduct };

function productMedia(db: SqliteDatabase, productIds: string[]): Map<string, Pick<ProductRecord, 'previewUrl' | 'thumbnailUrl' | 'assetIds' | 'publishedAssetIds'>> {
  const result = new Map<string, Pick<ProductRecord, 'previewUrl' | 'thumbnailUrl' | 'assetIds' | 'publishedAssetIds'>>();
  if (!productIds.length) return result;
  const placeholders = productIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pa.product_id, pa.asset_id,
      CASE
        WHEN linked.derivative_kind IS NOT NULL THEN linked.id
        ELSE (
          SELECT derivative.id
          FROM pipeline_assets derivative
          WHERE derivative.source_asset_id = linked.id
            AND derivative.derivative_kind IS NOT NULL
          ORDER BY derivative.created_at, derivative.id
          LIMIT 1
        )
      END AS published_asset_id
    FROM product_assets pa
    LEFT JOIN pipeline_assets linked ON linked.id = pa.asset_id
    WHERE pa.product_id IN (${placeholders})
    ORDER BY pa.product_id, pa.is_primary DESC, pa.sort_order, pa.asset_id
  `).all(...productIds) as Array<{ product_id: string; asset_id: string; published_asset_id: string | null }>;
  for (const productId of productIds) {
    const productRows = rows.filter((row) => row.product_id === productId);
    const assetIds = productRows.map((row) => row.asset_id);
    if (!assetIds.length) continue;
    const publishedAssetIds = [...new Set(productRows.map((row) => row.published_asset_id).filter((id): id is string => Boolean(id)))].slice(0, 8);
    const derivativeId = publishedAssetIds[0];
    const url = derivativeId ? `/api/v1/media/${encodeURIComponent(derivativeId)}` : null;
    result.set(productId, { assetIds, publishedAssetIds, previewUrl: url, thumbnailUrl: url });
  }
  return result;
}

function assertCategory(db: SqliteDatabase, categoryId: string): { parentId: string | null } {
  const row = db.prepare('SELECT active, parent_id parentId FROM taxonomy_categories WHERE id = ?').get(categoryId) as { active: number; parentId: string | null } | undefined;
  if (!row || row.active !== 1) throw new Error('分类不存在或已停用');
  return row;
}

function assertCategorySelection(db: SqliteDatabase, categoryId: string, subcategoryId?: string | null): void {
  assertCategory(db, categoryId);
  if (!subcategoryId) return;
  const subcategory = assertCategory(db, subcategoryId);
  if (subcategory.parentId !== categoryId) throw new Error('子类目不属于所选一级类目');
}

function replaceProductAssets(db: SqliteDatabase, productId: string, assetIds: string[], timestamp: string): void {
  if (assetIds.length > 8 || new Set(assetIds).size !== assetIds.length) throw new Error('商品图片必须唯一且最多 8 张');
  if (assetIds.length) {
    const placeholders = assetIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, mime_type mimeType, derivative_kind derivativeKind FROM pipeline_assets WHERE id IN (${placeholders})`).all(...assetIds) as Array<{ id: string; mimeType: string; derivativeKind: string | null }>;
    if (rows.length !== assetIds.length || rows.some((asset) => !asset.mimeType.startsWith('image/') || !asset.derivativeKind)) throw new Error('商品图片必须是已处理的受控图片');
  }
  db.prepare('DELETE FROM product_assets WHERE product_id = ?').run(productId);
  const insert = db.prepare('INSERT INTO product_assets (product_id, asset_id, is_primary, sort_order, created_at) VALUES (?, ?, ?, ?, ?)');
  assetIds.forEach((assetId, index) => insert.run(productId, assetId, index === 0 ? 1 : 0, index, timestamp));
}

function normalizedVariant(variant: ProductVariantInput): ProductVariantInput {
  const raw = clean(variant.barcodeRaw, 128);
  const barcode = raw ? normalizeBarcode(raw, variant.barcodeSymbology ?? undefined) : null;
  return {
    ...variant,
    sku: clean(variant.sku, 128),
    barcodeRaw: raw,
    barcodeNormalized: barcode?.normalized ?? clean(variant.barcodeNormalized, 128),
    barcodeSymbology: barcode?.symbology ?? variant.barcodeSymbology ?? null,
    barcodeValid: barcode?.checksumValid ?? variant.barcodeValid ?? null,
    specification: clean(variant.specification, 240) ?? '',
    netContent: clean(variant.netContent, 120),
    unit: clean(variant.unit, 40),
    packaging: clean(variant.packaging, 120),
    color: clean(variant.color, 120),
    scent: clean(variant.scent, 120),
    price: asNullableNumber(variant.price),
    stock: variant.stock == null ? null : Number(variant.stock),
  };
}

export function createProduct(input: BeautyProductInput, auditEvent?: AuditEvent, submitForReview = false): ProductRecord {
  return withWriteLeaseSync('catalog.product.create', (lease) => {
    lease.assertActive();
    return createProductWithinLease(input, auditEvent, submitForReview);
  });
}

function createProductWithinLease(input: BeautyProductInput, auditEvent?: AuditEvent, submitForReview = false): ProductRecord {
  const id = `prod-${randomUUID()}`;
  const timestamp = now();
  const variants = input.variants.map(normalizedVariant);
  if (!input.name.trim() || !input.categoryId || !variants.length || variants.some((variant) => !variant.specification)) throw new Error('商品名、分类和至少一个规格不能为空');
  withTransaction((db) => {
    assertCategorySelection(db, input.categoryId, input.subcategoryId);
    db.prepare(`INSERT INTO products (id, name, brand, category_id, subcategory_id, description, ingredients, efficacy, directions, warnings, country_of_origin, manufacturer, license_number, batch_number, production_date, shelf_life, expiry_date, notes, source_group_id, entry_source, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 1, ?, ?)`)
      .run(id, clean(input.name, 240), clean(input.brand, 160), input.categoryId, input.subcategoryId ?? null, clean(input.description), clean(input.ingredients), clean(input.efficacy), clean(input.directions), clean(input.warnings), clean(input.countryOfOrigin), clean(input.manufacturer), clean(input.licenseNumber), clean(input.batchNumber), clean(input.productionDate, 64), clean(input.shelfLife, 128), clean(input.expiryDate, 64), clean(input.notes), input.sourceGroupId ?? null, submitForReview ? 'review_pending' : 'draft', timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, price, stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const variant of variants) insert.run(`var-${randomUUID()}`, id, variant.sku ?? null, variant.barcodeRaw ?? null, variant.barcodeNormalized ?? null, variant.barcodeSymbology ?? null, variant.barcodeValid == null ? null : variant.barcodeValid ? 1 : 0, variant.specification, variant.netContent ?? null, variant.unit ?? null, variant.packaging ?? null, variant.color ?? null, variant.scent ?? null, variant.price ?? null, variant.stock ?? null, timestamp, timestamp);
    replaceProductAssets(db, id, input.assetIds ?? [], timestamp);
    if (auditEvent) recordAuditWithDb(db, { ...auditEvent, resourceId: id });
    const product = getProduct(id);
    if (!product) throw new Error('商品保存失败');
    enqueueOrderProduct(product);
  });
  const product = getProduct(id);
  if (!product) throw new Error('商品保存失败');
  return product;
}

export function updateProduct(id: string, input: BeautyProductInput, expectedRevision?: number, auditEvent?: AuditEvent, submitForReview = false): ProductRecord {
  return withWriteLeaseSync('catalog.product.update', (lease) => {
    lease.assertActive();
    return updateProductWithinLease(id, input, expectedRevision, auditEvent, submitForReview);
  });
}

function updateProductWithinLease(id: string, input: BeautyProductInput, expectedRevision?: number, auditEvent?: AuditEvent, submitForReview = false): ProductRecord {
  const current = getProduct(id);
  if (!current) throw new Error('商品不存在');
  if (expectedRevision != null && expectedRevision !== current.revision) throw new Error('商品已被其他人修改，请刷新后重试');
  const variants = input.variants.map(normalizedVariant);
  if (!input.name.trim() || !input.categoryId || !variants.length || variants.some((variant) => !variant.specification)) throw new Error('商品名、分类和至少一个规格不能为空');
  const timestamp = now();
  const compareRevision = expectedRevision ?? current.revision;
  withTransaction((db) => {
    assertCategorySelection(db, input.categoryId, input.subcategoryId);
    const updated = db.prepare(`UPDATE products SET name=?, brand=?, category_id=?, subcategory_id=?, description=?, ingredients=?, efficacy=?, directions=?, warnings=?, country_of_origin=?, manufacturer=?, license_number=?, batch_number=?, production_date=?, shelf_life=?, expiry_date=?, notes=?, status=CASE WHEN ? = 1 OR status IN ('approved','published') THEN 'review_pending' ELSE status END, revision=revision+1, reviewed_at=NULL, reviewed_by=NULL, published_at=NULL, updated_at=? WHERE id=? AND revision=?`).run(clean(input.name, 240), clean(input.brand, 160), input.categoryId, input.subcategoryId ?? null, clean(input.description), clean(input.ingredients), clean(input.efficacy), clean(input.directions), clean(input.warnings), clean(input.countryOfOrigin), clean(input.manufacturer), clean(input.licenseNumber), clean(input.batchNumber, 64), clean(input.productionDate, 64), clean(input.shelfLife, 128), clean(input.expiryDate, 64), clean(input.notes), submitForReview ? 1 : 0, timestamp, id, compareRevision);
    if (!updated.changes) throw new Error('商品已被其他人修改，请刷新后重试');
    const existingIds = new Set((db.prepare('SELECT id FROM product_variants WHERE product_id = ? AND deleted_at IS NULL').all(id) as Array<{ id: string }>).map((row) => row.id));
    const retainedIds = new Set<string>();
    const insert = db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, price, stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE product_variants SET sku=?, barcode_raw=?, barcode_normalized=?, barcode_symbology=?, barcode_valid=?, specification=?, net_content=?, unit=?, packaging=?, color=?, scent=?, price=?, stock=?, deleted_at=NULL, updated_at=? WHERE id=? AND product_id=?`);
    for (const variant of variants) {
      if (variant.id) {
        if (!existingIds.has(variant.id) || retainedIds.has(variant.id)) throw new Error('规格 ID 不属于当前商品或重复');
        retainedIds.add(variant.id);
        update.run(variant.sku ?? null, variant.barcodeRaw ?? null, variant.barcodeNormalized ?? null, variant.barcodeSymbology ?? null, variant.barcodeValid == null ? null : variant.barcodeValid ? 1 : 0, variant.specification, variant.netContent ?? null, variant.unit ?? null, variant.packaging ?? null, variant.color ?? null, variant.scent ?? null, variant.price ?? null, variant.stock ?? null, timestamp, variant.id, id);
      } else {
        const variantId = `var-${randomUUID()}`;
        retainedIds.add(variantId);
        insert.run(variantId, id, variant.sku ?? null, variant.barcodeRaw ?? null, variant.barcodeNormalized ?? null, variant.barcodeSymbology ?? null, variant.barcodeValid == null ? null : variant.barcodeValid ? 1 : 0, variant.specification, variant.netContent ?? null, variant.unit ?? null, variant.packaging ?? null, variant.color ?? null, variant.scent ?? null, variant.price ?? null, variant.stock ?? null, timestamp, timestamp);
      }
    }
    const removedIds = [...existingIds].filter((variantId) => !retainedIds.has(variantId));
    if (removedIds.length) db.prepare(`UPDATE product_variants SET deleted_at=?,updated_at=? WHERE product_id = ? AND deleted_at IS NULL AND id IN (${removedIds.map(() => '?').join(',')})`).run(timestamp, timestamp, id, ...removedIds);
    if (input.assetIds !== undefined) replaceProductAssets(db, id, input.assetIds, timestamp);
    if (auditEvent) recordAuditWithDb(db, { ...auditEvent, resourceId: id });
    const currentProduct = getProduct(id);
    if (!currentProduct) throw new Error('Edited product could not be loaded');
    enqueueOrderProduct(currentProduct);
  });
  const updatedProduct = getProduct(id)!;
  return updatedProduct;
}

export class ProductDeleteError extends Error {
  readonly code: 'PRODUCT_NOT_FOUND' | 'PRODUCT_DELETE_FORBIDDEN';
  readonly status: number;

  constructor(code: 'PRODUCT_NOT_FOUND' | 'PRODUCT_DELETE_FORBIDDEN', message: string, status: number) {
    super(message);
    this.name = 'ProductDeleteError';
    this.code = code;
    this.status = status;
  }
}

export function unpublishProduct(id: string, auditEvent?: AuditEvent): ProductRecord {
  return withWriteLeaseSync('catalog.product.unpublish', (lease) => {
    lease.assertActive();
    const current = getProduct(id);
    if (!current) throw new ProductDeleteError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (current.status !== 'published') throw new ProductDeleteError('PRODUCT_DELETE_FORBIDDEN', 'Only published products can be unpublished', 409);
    const timestamp = now();
    withTransaction((db) => {
      const result = db.prepare("UPDATE products SET status='needs_changes', revision=revision+1, reviewed_at=NULL, reviewed_by=NULL, published_at=NULL, updated_at=? WHERE id=? AND status='published'").run(timestamp, id);
      if (!result.changes) throw new ProductDeleteError('PRODUCT_DELETE_FORBIDDEN', 'Product changed while unpublishing', 409);
      if (auditEvent) recordAuditWithDb(db, { ...auditEvent, resourceId: id });
      const product = getProduct(id);
      if (!product) throw new ProductDeleteError('PRODUCT_NOT_FOUND', 'Product not found', 404);
      enqueueOrderProduct(product, 'inactive');
    });
    const product = getProduct(id)!;
    return product;
  });
}

/** Rejected catalog entries can be removed from the catalog; published data is never hard-deleted here. */
export function deleteRejectedProduct(id: string, auditEvent?: AuditEvent): void {
  withWriteLeaseSync('catalog.product.delete', (lease) => {
    lease.assertActive();
    withTransaction((db) => {
      const product = db.prepare('SELECT id, status, ever_published_at everPublishedAt FROM products WHERE id = ? AND archived_at IS NULL').get(id) as { id: string; status: ProductStatus; everPublishedAt: string | null } | undefined;
      if (!product) throw new ProductDeleteError('PRODUCT_NOT_FOUND', '商品不存在', 404);
      if (product.status !== 'rejected') throw new ProductDeleteError('PRODUCT_DELETE_FORBIDDEN', '只有已拒绝商品可以完整删除', 409);
      if (auditEvent) recordAuditWithDb(db, { ...auditEvent, resourceId: id });
      if (!product.everPublishedAt) {
        db.prepare('DELETE FROM products WHERE id = ? AND status = ? AND archived_at IS NULL').run(id, 'rejected');
        return;
      }
      const timestamp = now();
      const archived = db.prepare(`UPDATE products SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND status='rejected' AND archived_at IS NULL`).run(timestamp, timestamp, id);
      if (!archived.changes) throw new ProductDeleteError('PRODUCT_DELETE_FORBIDDEN', '商品归档状态已变化，请刷新后重试', 409);
      db.prepare('UPDATE product_variants SET deleted_at=?,updated_at=? WHERE product_id=? AND deleted_at IS NULL').run(timestamp, timestamp, id);
      const archivedProduct = getProduct(id, true);
      if (!archivedProduct) throw new ProductDeleteError('PRODUCT_NOT_FOUND', '归档商品读取失败', 404);
      enqueueOrderProduct(archivedProduct, 'inactive');
    });
  });
}

export function listReviewProducts(limit = 100): ProductRecord[] {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
  return listProducts({ status: 'all', limit: 500 }).products
    .filter((product) => product.status === 'review_pending' || product.status === 'draft' || product.status === 'needs_changes')
    .slice(0, bounded);
}

export interface ReviewPipelineSync {
  id: string;
  itemId: string;
  jobId: string;
  targetStatus: 'succeeded' | 'failed' | 'needs_review';
  patch: Record<string, unknown>;
}

function applyReviewInput(db: SqliteDatabase, id: string, revision: number, input: BeautyProductInput, variants: ProductVariantInput[], timestamp: string): void {
  assertCategorySelection(db, input.categoryId, input.subcategoryId);
  const edited = db.prepare(`UPDATE products SET name=?, brand=?, category_id=?, subcategory_id=?, description=?, ingredients=?, efficacy=?, directions=?, warnings=?, country_of_origin=?, manufacturer=?, license_number=?, batch_number=?, production_date=?, shelf_life=?, expiry_date=?, notes=?, reviewed_at=NULL, reviewed_by=NULL, published_at=NULL, updated_at=? WHERE id=? AND revision=?`).run(clean(input.name, 240), clean(input.brand, 160), input.categoryId, input.subcategoryId ?? null, clean(input.description), clean(input.ingredients), clean(input.efficacy), clean(input.directions), clean(input.warnings), clean(input.countryOfOrigin), clean(input.manufacturer), clean(input.licenseNumber), clean(input.batchNumber, 64), clean(input.productionDate, 64), clean(input.shelfLife, 128), clean(input.expiryDate, 64), clean(input.notes), timestamp, id, revision);
  if (!edited.changes) throw new Error('Review revision changed; refresh and retry');
  const existingIds = new Set((db.prepare('SELECT id FROM product_variants WHERE product_id = ? AND deleted_at IS NULL').all(id) as Array<{ id: string }>).map((row) => row.id));
  const retainedIds = new Set<string>();
  const insert = db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, price, stock, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE product_variants SET sku=?, barcode_raw=?, barcode_normalized=?, barcode_symbology=?, barcode_valid=?, specification=?, net_content=?, unit=?, packaging=?, color=?, scent=?, price=?, stock=?, deleted_at=NULL, updated_at=? WHERE id=? AND product_id=?`);
  for (const variant of variants) {
    if (variant.id) {
      if (!existingIds.has(variant.id) || retainedIds.has(variant.id)) throw new Error('Variant ID does not belong to this product or is duplicated');
      retainedIds.add(variant.id);
      update.run(variant.sku ?? null, variant.barcodeRaw ?? null, variant.barcodeNormalized ?? null, variant.barcodeSymbology ?? null, variant.barcodeValid == null ? null : variant.barcodeValid ? 1 : 0, variant.specification, variant.netContent ?? null, variant.unit ?? null, variant.packaging ?? null, variant.color ?? null, variant.scent ?? null, variant.price ?? null, variant.stock ?? null, timestamp, variant.id, id);
    } else {
      const variantId = `var-${randomUUID()}`;
      retainedIds.add(variantId);
      insert.run(variantId, id, variant.sku ?? null, variant.barcodeRaw ?? null, variant.barcodeNormalized ?? null, variant.barcodeSymbology ?? null, variant.barcodeValid == null ? null : variant.barcodeValid ? 1 : 0, variant.specification, variant.netContent ?? null, variant.unit ?? null, variant.packaging ?? null, variant.color ?? null, variant.scent ?? null, variant.price ?? null, variant.stock ?? null, timestamp, timestamp);
    }
  }
  const removedIds = [...existingIds].filter((variantId) => !retainedIds.has(variantId));
  if (removedIds.length) db.prepare(`UPDATE product_variants SET deleted_at=?,updated_at=? WHERE product_id = ? AND deleted_at IS NULL AND id IN (${removedIds.map(() => '?').join(',')})`).run(timestamp, timestamp, id, ...removedIds);
  if (input.assetIds !== undefined) replaceProductAssets(db, id, input.assetIds, timestamp);
}

export function reviewProduct(id: string, actor: { id: string; role: 'admin' | 'reviewer' }, decision: 'approve' | 'reject' | 'needs_changes', reason?: string, expectedRevision?: number, pipelineSync?: ReviewPipelineSync, reviewInput?: BeautyProductInput, auditEvent?: AuditEvent): ProductRecord {
  return withWriteLeaseSync('catalog.product.review', (lease) => {
    lease.assertActive();
    return reviewProductWithinLease(id, actor, decision, reason, expectedRevision, pipelineSync, reviewInput, auditEvent);
  });
}

function reviewProductWithinLease(id: string, actor: { id: string; role: 'admin' | 'reviewer' }, decision: 'approve' | 'reject' | 'needs_changes', reason?: string, expectedRevision?: number, pipelineSync?: ReviewPipelineSync, reviewInput?: BeautyProductInput, auditEvent?: AuditEvent): ProductRecord {
  const product = getProduct(id);
  if (!product) throw new Error('商品不存在');
  let reviewProductRecord: ProductRecord = product;
  if (!['draft', 'review_pending', 'needs_changes'].includes(product.status)) throw new Error('商品当前状态不可审核');
  if (expectedRevision != null && expectedRevision !== product.revision) {
    throw Object.assign(new Error('审核版本已变化，请刷新后重试'), { code: 'REVIEW_REVISION_CONFLICT', status: 409 });
  }
  if (reviewInput && decision !== 'approve') throw new Error('Only approval may include catalog revisions');
  const normalizedReviewVariants = reviewInput?.variants.map(normalizedVariant);
  if (reviewInput && (!reviewInput.name.trim() || !reviewInput.categoryId || !normalizedReviewVariants?.length || normalizedReviewVariants.some((variant) => !variant.specification))) throw new Error('Product name, category and at least one variant are required');
  const timestamp = now();
  const nextStatus: ProductStatus = decision === 'approve' ? 'published' : decision === 'reject' ? 'rejected' : 'needs_changes';
  withTransaction((db) => {
    if (reviewInput && normalizedReviewVariants) {
      applyReviewInput(db, id, reviewProductRecord.revision, reviewInput, normalizedReviewVariants, timestamp);
      reviewProductRecord = getProduct(id)!;
    }
    const validation = validateForPublish(reviewProductRecord);
    const manualReadinessErrors = reviewProductRecord.entrySource === 'manual' ? validateManualProductReadiness(reviewProductRecord) : [];
    if (decision === 'approve' && (!validation.ok || manualReadinessErrors.length)) {
      throw Object.assign(new Error(`Product is not ready: ${[...validation.errors.map((item) => item.message), ...manualReadinessErrors].join('; ')}`), { code: 'PRODUCT_NOT_READY', status: 409 });
    }
    if (decision === 'approve') {
      assertCategorySelection(db, reviewProductRecord.categoryId, reviewProductRecord.subcategoryId);
    }
    const result = db.prepare(`UPDATE products SET status=?, revision=revision+1, reviewed_at=?, reviewed_by=?, published_at=?, ever_published_at=CASE WHEN ?='approve' THEN COALESCE(ever_published_at,?) ELSE ever_published_at END, updated_at=? WHERE id=? AND revision=?`).run(nextStatus, timestamp, actor.id, decision === 'approve' ? timestamp : null, decision, timestamp, timestamp, id, reviewProductRecord.revision);
    if (!result.changes) throw new Error('审核版本已变化，请刷新后重试');
    db.prepare('INSERT INTO review_decisions (id, product_id, revision, actor_user_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`review-${randomUUID()}`, id, reviewProductRecord.revision + 1, actor.id, decision, clean(reason, 2000), timestamp);
    if (pipelineSync) {
      const encoded = JSON.stringify(pipelineSync.patch);
      if (encoded.length > 64_000) throw new Error('审核同步内容超过限制');
      db.prepare(`INSERT INTO review_sync_outbox (id, item_id, job_id, target_status, patch_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(pipelineSync.id, pipelineSync.itemId, pipelineSync.jobId, pipelineSync.targetStatus, encoded, timestamp);
    }
    const reviewed = getProduct(id);
    if (!reviewed) throw new Error('审核后的商品读取失败');
    enqueueOrderProduct(reviewed);
    if (auditEvent) {
      recordAuditWithDb(db, { ...auditEvent, resourceId: id, metadata: { revision: reviewProductRecord.revision + 1, reason } });
    }
  });
  const reviewed = getProduct(id)!;
  return reviewed;
}

function validateManualProductReadiness(product: ProductRecord): string[] {
  const errors: string[] = [];
  if (!product.publishedAssetIds?.length) errors.push('人工商品至少需要一张已处理图片');
  product.variants.forEach((variant, index) => {
    if (variant.price == null) errors.push(`规格 ${index + 1} 必须填写价格`);
    if (variant.stock == null) errors.push(`规格 ${index + 1} 必须填写库存`);
  });
  return errors;
}

export function countProducts(status?: ProductStatus): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM products ${status ? 'WHERE status = ?' : ''}`).get(...(status ? [status] : [])) as { count: number };
  return Number(row.count);
}
