import { randomUUID } from "node:crypto";
import { getDb, withTransaction, type SqliteDatabase } from "../db";
import { getProduct, reviewProduct, updateProduct, type ReviewPipelineSync } from "../catalog-repository";
import { normalizeBarcode } from "../barcode";
import type { ProductRecord } from "../contracts/catalog";
import type { BackLabelFields } from "../contracts/pipeline";

export interface CandidateInput {
  itemId: string;
  jobId: string;
  sourceAssetId: string;
  derivativeAssetId?: string;
  category?: string;
  group?: string;
  backLabel?: BackLabelFields;
  confidence?: number;
  /** Re-project a previously linked, editable candidate after an item retry.
   * Ordinary calls remain idempotent and return the existing link. */
  rerun?: boolean;
  /** Stable identifier for the provider execution generation. */
  aiRunId?: string;
}

export interface CandidateResult {
  productId: string;
  groupId: string;
  product: ProductRecord | null;
  idempotent: boolean;
  revision?: number;
  aiRunId?: string;
}

export interface CandidateEvidenceView {
  id: string;
  fieldKey: string;
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number | null;
  source: string;
  state: string;
  sourceAssetIds: string[];
  sourceRegion: { x: number; y: number; width: number; height: number } | null;
  aiRunId: string | null;
  revision: number;
  createdAt: string;
}

export function listCandidateEvidence(productId: string): CandidateEvidenceView[] {
  const rows = getDb().prepare('SELECT id, field_key, raw_value, normalized_value, confidence, source, state, source_asset_ids_json, source_region_json, ai_run_id, revision, created_at FROM field_evidence WHERE product_id = ? ORDER BY field_key, revision DESC, created_at DESC').all(productId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id), fieldKey: String(row.field_key), rawValue: row.raw_value == null ? null : String(row.raw_value),
    normalizedValue: row.normalized_value == null ? null : String(row.normalized_value), confidence: row.confidence == null ? null : Number(row.confidence),
    source: String(row.source), state: String(row.state), sourceAssetIds: parseStringArray(row.source_asset_ids_json), sourceRegion: parseRegion(row.source_region_json), aiRunId: row.ai_run_id == null ? null : String(row.ai_run_id), revision: Number(row.revision || 1), createdAt: String(row.created_at),
  }));
}

export function listCandidateAssetIds(productId: string): Array<{ assetId: string; isPrimary: boolean; sortOrder: number }> {
  const rows = getDb().prepare('SELECT asset_id, is_primary, sort_order FROM product_assets WHERE product_id = ? ORDER BY sort_order, asset_id').all(productId) as Array<{ asset_id: string; is_primary: number; sort_order: number }>;
  return rows.map((row) => ({ assetId: row.asset_id, isPrimary: row.is_primary === 1, sortOrder: Number(row.sort_order) }));
}

export function getPipelineCandidateLink(productId: string): { itemId: string; jobId: string | null } | null {
  const row = getDb().prepare(`SELECT l.item_id, g.job_id
    FROM pipeline_candidate_links l LEFT JOIN candidate_groups g ON g.id = l.group_id
    WHERE l.product_id = ? ORDER BY l.created_at LIMIT 1`).get(productId) as { item_id: string; job_id: string | null } | undefined;
  return row ? { itemId: row.item_id, jobId: row.job_id } : null;
}

export function listCandidateGroups(jobId?: string): Array<{ id: string; name: string; categoryId: string | null; status: string; confidence: number | null; itemIds: string[] }> {
  const rows = (jobId
    ? getDb().prepare('SELECT * FROM candidate_groups WHERE job_id = ? ORDER BY updated_at DESC').all(jobId,)
    : getDb().prepare('SELECT * FROM candidate_groups ORDER BY updated_at DESC LIMIT 500').all()) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = String(row.id);
    const itemIds = (getDb().prepare('SELECT item_id FROM pipeline_candidate_links WHERE group_id = ? ORDER BY created_at').all(id) as Array<{ item_id: string }>).map((item) => item.item_id);
    return { id, name: String(row.name), categoryId: row.category_id == null ? null : String(row.category_id), status: String(row.status), confidence: row.confidence == null ? null : Number(row.confidence), itemIds };
  });
}

/** Persist a human-created group in the catalogue projection. The legacy
 * PipelineStore group is intentionally not the source of truth once a
 * candidate has been projected to SQLite. */
export function createManualCandidateGroup(name: string, itemIds: string[], category?: string): { id: string; name: string; categoryId: string | null; itemIds: string[] } {
  const trimmed = clean(name, 120);
  const unique = [...new Set(itemIds.filter((item) => typeof item === 'string' && item.trim()))];
  if (!trimmed) throw new Error('分组名称不能为空');
  if (!unique.length || unique.length > 500) throw new Error('分组至少需要一个条目');
  const timestamp = new Date().toISOString();
  let created: { id: string; categoryId: string | null } | undefined;
  withTransaction((db) => {
    const placeholders = unique.map(() => '?').join(',');
    const links = db.prepare(`SELECT l.item_id, l.product_id, l.group_id, g.job_id FROM pipeline_candidate_links l LEFT JOIN candidate_groups g ON g.id = l.group_id WHERE l.item_id IN (${placeholders})`).all(...unique) as Array<{ item_id: string; product_id: string; group_id: string | null; job_id: string | null }>;
    if (links.length !== unique.length) throw new Error('部分条目尚未生成候选商品，无法持久化分组');
    const jobs = [...new Set(links.map((link) => link.job_id).filter(Boolean))];
    if (jobs.length > 1) throw new Error('同一分组不能跨导入任务');
    const categoryId = resolveCategory(db, category);
    const id = `group-${randomUUID()}`;
    db.prepare(`INSERT INTO candidate_groups (id, job_id, name, category_id, match_source, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'human', NULL, 'pending', ?, ?)`).run(id, jobs[0] ?? null, trimmed, categoryId, timestamp, timestamp);
    const updateLink = db.prepare('UPDATE pipeline_candidate_links SET group_id = ? WHERE item_id = ?');
    for (const itemId of unique) updateLink.run(id, itemId);
    const productIds = [...new Set(links.map((link) => link.product_id))];
    const updateProduct = db.prepare('UPDATE products SET source_group_id = ?, updated_at = ? WHERE id = ?');
    for (const productId of productIds) updateProduct.run(id, timestamp, productId);
    const copyAssets = db.prepare(`INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at)
      SELECT ?, asset_id, 'unknown', sort_order, ? FROM group_assets WHERE group_id IN (${[...new Set(links.map((link) => link.group_id).filter(Boolean))].map(() => '?').join(',') || "NULL"})`);
    const oldGroups = [...new Set(links.map((link) => link.group_id).filter((value): value is string => Boolean(value)))];
    if (oldGroups.length) copyAssets.run(id, timestamp, ...oldGroups);
    for (const oldGroup of oldGroups) {
      const remaining = db.prepare('SELECT COUNT(*) AS count FROM pipeline_candidate_links WHERE group_id = ?').get(oldGroup) as { count: number };
      if (Number(remaining.count) === 0) db.prepare("UPDATE candidate_groups SET status = 'split', updated_at = ? WHERE id = ? AND status = 'pending'").run(timestamp, oldGroup);
    }
    created = { id, categoryId };
  });
  if (!created) throw new Error('分组创建失败');
  return { id: created.id, name: trimmed, categoryId: created.categoryId, itemIds: unique };
}

export function assignCandidateItemGroup(itemId: string, name: string, category?: string): string {
  const trimmed = clean(name, 120);
  if (!trimmed) throw new Error('分组名称不能为空');
  let groupId = '';
  withTransaction((db) => {
    const link = db.prepare(`SELECT l.product_id, l.group_id, g.job_id FROM pipeline_candidate_links l LEFT JOIN candidate_groups g ON g.id = l.group_id WHERE l.item_id = ?`).get(itemId) as { product_id: string; group_id: string | null; job_id: string | null } | undefined;
    if (!link) throw new Error('条目尚未生成候选商品');
    const existing = db.prepare("SELECT id FROM candidate_groups WHERE job_id IS ? AND name = ? AND status IN ('pending','confirmed') ORDER BY created_at LIMIT 1").get(link.job_id ?? null, trimmed) as { id: string } | undefined;
    groupId = existing?.id || `group-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    if (!existing) db.prepare(`INSERT INTO candidate_groups (id, job_id, name, category_id, match_source, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'human', NULL, 'pending', ?, ?)`).run(groupId, link.job_id ?? null, trimmed, resolveCategory(db, category), timestamp, timestamp);
    db.prepare('UPDATE pipeline_candidate_links SET group_id = ? WHERE item_id = ?').run(groupId, itemId);
    db.prepare('UPDATE products SET source_group_id = ?, updated_at = ? WHERE id = ?').run(groupId, timestamp, link.product_id);
    if (link.group_id && link.group_id !== groupId) {
      db.prepare(`INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) SELECT ?, asset_id, view_type, sort_order, ? FROM group_assets WHERE group_id = ?`).run(groupId, timestamp, link.group_id);
    }
  });
  return groupId;
}

export function clearCandidateItemGroup(itemId: string): void {
  withTransaction((db) => {
    const link = db.prepare('SELECT product_id, group_id FROM pipeline_candidate_links WHERE item_id = ?').get(itemId) as { product_id: string; group_id: string | null } | undefined;
    if (!link) throw new Error('条目尚未生成候选商品');
    db.prepare('UPDATE pipeline_candidate_links SET group_id = NULL WHERE item_id = ?').run(itemId);
    db.prepare('UPDATE products SET source_group_id = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), link.product_id);
    if (link.group_id) {
      const left = db.prepare('SELECT COUNT(*) AS count FROM pipeline_candidate_links WHERE group_id = ?').get(link.group_id) as { count: number };
      if (Number(left.count) === 0) db.prepare("UPDATE candidate_groups SET status = 'ignored', updated_at = ? WHERE id = ? AND status IN ('pending','confirmed')").run(new Date().toISOString(), link.group_id);
    }
  });
}

export function mergeCandidateGroups(sourceId: string, targetId: string): void {
  if (!sourceId || !targetId || sourceId === targetId) throw new Error('合并分组参数无效');
  withTransaction((db) => {
    const source = db.prepare('SELECT id, status FROM candidate_groups WHERE id = ?').get(sourceId) as { id: string; status: string } | undefined;
    const target = db.prepare('SELECT id, status FROM candidate_groups WHERE id = ?').get(targetId) as { id: string; status: string } | undefined;
    if (!source || !target) throw new Error('分组不存在');
    const jobs = db.prepare('SELECT DISTINCT job_id FROM candidate_groups WHERE id IN (?, ?)').all(sourceId, targetId) as Array<{ job_id: string | null }>;
    if (jobs.length > 1 && jobs.some((row) => row.job_id !== jobs[0]?.job_id)) throw new Error('不能合并不同导入任务的分组');
    if (source.status === 'merged' || source.status === 'ignored' || target.status === 'merged' || target.status === 'ignored') throw new Error('当前分组状态不允许合并');
    db.prepare('UPDATE pipeline_candidate_links SET group_id = ? WHERE group_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE products SET source_group_id = ?, updated_at = ? WHERE source_group_id = ?').run(targetId, new Date().toISOString(), sourceId);
    db.prepare('INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) SELECT ?, asset_id, view_type, sort_order, created_at FROM group_assets WHERE group_id = ?').run(targetId, sourceId);
    db.prepare('DELETE FROM group_assets WHERE group_id = ?').run(sourceId);
    db.prepare("UPDATE candidate_groups SET status = 'merged', updated_at = ? WHERE id = ?").run(new Date().toISOString(), sourceId);
    db.prepare("UPDATE candidate_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), targetId);
  });
}

export function splitCandidateGroup(groupId: string, itemIds: string[], name: string): string {
  const unique = [...new Set(itemIds.filter((item) => typeof item === 'string' && item))];
  if (!unique.length) throw new Error('拆分至少需要一个条目');
  const newId = `group-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  withTransaction((db) => {
    const source = db.prepare('SELECT job_id, category_id, confidence FROM candidate_groups WHERE id = ? AND status IN (\'pending\', \'confirmed\')').get(groupId) as { job_id: string | null; category_id: string | null; confidence: number | null } | undefined;
    if (!source) throw new Error('可拆分分组不存在或状态不允许');
    const placeholders = unique.map(() => '?').join(',');
    const linked = db.prepare(`SELECT item_id, product_id FROM pipeline_candidate_links WHERE group_id = ? AND item_id IN (${placeholders})`).all(groupId, ...unique) as Array<{ item_id: string; product_id: string }>;
    if (linked.length !== unique.length) throw new Error('拆分条目必须全部属于源分组');
    db.prepare("INSERT INTO candidate_groups (id, job_id, name, category_id, match_source, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'human', ?, 'pending', ?, ?)").run(newId, source.job_id, name.trim().slice(0, 120) || `拆分-${newId.slice(-8)}`, source.category_id, source.confidence, timestamp, timestamp);
    const update = db.prepare('UPDATE pipeline_candidate_links SET group_id = ? WHERE item_id = ? AND group_id = ?');
    for (const itemId of unique) update.run(newId, itemId, groupId);
    const updateProducts = db.prepare('UPDATE products SET source_group_id = ?, updated_at = ? WHERE id = ?');
    for (const item of linked) updateProducts.run(newId, timestamp, item.product_id);
    db.prepare('INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) SELECT ?, asset_id, view_type, sort_order, ? FROM group_assets WHERE group_id = ?').run(newId, timestamp, groupId);
    db.prepare("UPDATE candidate_groups SET updated_at = ? WHERE id = ?").run(timestamp, groupId);
  });
  return newId;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch { return []; }
}

function parseRegion(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const values = [parsed?.x, parsed?.y, parsed?.width, parsed?.height];
    if (!values.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
    return { x: Number(parsed.x), y: Number(parsed.y), width: Number(parsed.width), height: Number(parsed.height) };
  } catch { return null; }
}

/**
 * Converts an AI item into a draft product candidate. The link table makes the
 * operation idempotent across worker retries/restarts; every candidate starts
 * in `review_pending` and cannot be exported until a human approves it.
 */
export class CatalogCandidateService {
  constructor(private readonly db: SqliteDatabase = getDb()) {}

  create(input: CandidateInput): CandidateResult {
    const existing = this.db.prepare("SELECT product_id, group_id FROM pipeline_candidate_links WHERE item_id = ?").get(input.itemId) as { product_id: string; group_id: string | null } | undefined;
    if (existing && input.rerun) return this.refreshExisting(existing, input);
    if (existing) return { productId: existing.product_id, groupId: existing.group_id || "", product: getProduct(existing.product_id), idempotent: true };
    const now = new Date().toISOString();
    const aiRunId = normalizeAiRunId(input.aiRunId) || `ai-${randomUUID()}`;
    const fields = input.backLabel || {};
    // Unknown values stay empty and are represented by review evidence rather
    // than a synthetic value that could accidentally satisfy publish gates.
    const productName = clean(fields.productName) || '';
    const categoryId = resolveCategory(this.db, input.category);
    const rawBarcode = clean(fields.barcode, 128);
    const barcode = rawBarcode ? normalizeBarcode(rawBarcode) : undefined;
    // Only valid, supported barcodes are strong identity evidence. Invalid
    // EAN/UPC values remain visible to the reviewer but must not auto-merge
    // otherwise unrelated products.
    const barcodeKey = barcode && barcode.symbology !== 'UNKNOWN' && (barcode.checksumValid !== false || barcode.symbology === 'CODE_128')
      ? barcode.normalized
      : null;
    // A normalized barcode is the strongest identity signal; vision grouping
    // is used only when no barcode was extracted.
    // Without a reliable identity signal, keep the image in an isolated
    // candidate group.  A blank/synthetic name must never merge unrelated
    // products; reviewers can explicitly merge groups later.
    const groupName = barcodeKey ? `barcode:${barcodeKey}` : clean(input.group) || productName || `item:${input.itemId}`;
    const confidence = clampConfidence(input.confidence);
    const grouped = this.db.prepare("SELECT id FROM candidate_groups WHERE job_id = ? AND name = ? AND category_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1").get(input.jobId, groupName, categoryId) as { id: string } | undefined;
    const groupId = grouped?.id || `group-${randomUUID()}`;
    const existingProduct = grouped ? this.db.prepare("SELECT id FROM products WHERE source_group_id = ? ORDER BY created_at LIMIT 1").get(groupId) as { id: string } | undefined : undefined;
    const productId = existingProduct?.id || `prod-${randomUUID()}`;
    const variantId = `var-${randomUUID()}`;
    withTransaction((db) => {
      if (!grouped) db.prepare("INSERT INTO candidate_groups (id, job_id, name, category_id, match_source, confidence, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)").run(groupId, input.jobId, groupName, categoryId, barcodeKey ? 'barcode' : 'vision', confidence, now, now);
      else db.prepare("UPDATE candidate_groups SET confidence = CASE WHEN confidence IS NULL OR confidence < ? THEN ? ELSE confidence END, updated_at = ? WHERE id = ?").run(confidence, confidence, now, groupId);
      if (!existingProduct) db.prepare(`INSERT INTO products (id, name, brand, category_id, description, ingredients, efficacy, directions, warnings, country_of_origin, manufacturer, license_number, batch_number, production_date, shelf_life, expiry_date, source_group_id, entry_source, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'review_pending', 1, ?, ?)`)
        .run(productId, productName, clean(fields.brand || fields.manufacturer), categoryId, clean(fields.description || fields.netContent), clean(fields.ingredients), clean(fields.efficacy), clean(fields.directions), clean(fields.warnings || fields.allergens), clean(fields.countryOfOrigin), clean(fields.manufacturer), clean(fields.licenseNumber), clean(fields.batchNumber), clean(fields.productionDate), clean(fields.shelfLife), clean(fields.expiry), groupId, now, now);
      db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(variantId, productId, clean(fields.sku), rawBarcode, barcode?.normalized || rawBarcode, barcode?.symbology || (rawBarcode ? 'UNKNOWN' : null), barcode ? (barcode.checksumValid == null ? null : barcode.checksumValid ? 1 : 0) : null, clean(fields.netContent || fields.packaging || fields.unit) || '', clean(fields.netContent), clean(fields.unit), clean(fields.packaging), clean(fields.color), clean(fields.scent), now, now);
      db.prepare("INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) VALUES (?, ?, 'unknown', 0, ?)").run(groupId, input.sourceAssetId, now);
      if (input.derivativeAssetId) db.prepare("INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) VALUES (?, ?, 'front', 1, ?)").run(groupId, input.derivativeAssetId, now);
      if (input.sourceAssetId) db.prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, is_primary, sort_order, created_at) VALUES (?, ?, 1, 0, ?)").run(productId, input.sourceAssetId, now);
      if (input.derivativeAssetId) db.prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, is_primary, sort_order, created_at) VALUES (?, ?, 0, 1, ?)").run(productId, input.derivativeAssetId, now);
      for (const [fieldKey, value] of Object.entries(fields)) {
        const text = clean(value);
        if (!text) continue;
        db.prepare("INSERT INTO field_evidence (id, product_id, group_id, field_key, raw_value, normalized_value, confidence, source, state, source_asset_ids_json, ai_run_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'vision', 'suggested', ?, ?, 1, ?)").run(`evidence-${randomUUID()}`, productId, groupId, fieldKey, text, text, confidence, JSON.stringify([input.sourceAssetId]), aiRunId, now);
      }
      const categoryText = clean(input.category);
      if (categoryText) db.prepare("INSERT INTO field_evidence (id, product_id, group_id, field_key, raw_value, normalized_value, confidence, source, state, source_asset_ids_json, ai_run_id, revision, created_at) VALUES (?, ?, ?, 'category', ?, ?, ?, 'vision', 'suggested', ?, ?, 1, ?)").run(`evidence-${randomUUID()}`, productId, groupId, categoryText, categoryId, confidence, JSON.stringify([input.sourceAssetId]), aiRunId, now);
      // Keep a marker even when the model returned no fields. This is the
      // durable idempotency boundary for crash/retry of an empty AI result.
      db.prepare("INSERT INTO candidate_ai_runs (product_id, ai_run_id, item_id, revision, created_at) VALUES (?, ?, ?, 1, ?)").run(productId, aiRunId, input.itemId, now);
      db.prepare("INSERT INTO pipeline_candidate_links (item_id, product_id, group_id, created_at) VALUES (?, ?, ?, ?)").run(input.itemId, productId, groupId, now);
    });
    return { productId, groupId, product: getProduct(productId), idempotent: false, revision: 1, aiRunId };
  }

  /** Refresh an existing item projection after an explicit AI retry.  The
   * link remains stable (item_id is the primary key), while the editable
   * product receives a new revision and immutable vision evidence rows.  The
   * latest human accepted/not-found evidence protects values from being
   * replaced by a later model response. */
  private refreshExisting(existing: { product_id: string; group_id: string | null }, input: CandidateInput): CandidateResult {
    const productId = existing.product_id;
    const row = this.db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as Record<string, unknown> | undefined;
    if (!row) throw catalogCandidateError("CANDIDATE_STATUS_UNKNOWN", "Candidate product is missing; retry is blocked");
    const aiRunId = normalizeAiRunId(input.aiRunId) || `ai-${randomUUID()}`;
    const duplicate = this.db.prepare("SELECT revision FROM candidate_ai_runs WHERE product_id = ? AND ai_run_id = ? LIMIT 1").get(productId, aiRunId) as { revision: number } | undefined
      || this.db.prepare("SELECT revision FROM field_evidence WHERE product_id = ? AND ai_run_id = ? LIMIT 1").get(productId, aiRunId) as { revision: number } | undefined;
    if (duplicate) return { productId, groupId: existing.group_id || "", product: getProduct(productId), idempotent: true, revision: Number(duplicate.revision), aiRunId };
    const status = String(row.status || "");
    if (!EDITABLE_CANDIDATE_STATUSES.has(status)) throw catalogCandidateError("CANDIDATE_RETRY_PUBLISHED", "Approved, published or rejected candidates cannot be overwritten by retry");

    const human = latestHumanEvidence(this.db, productId);
    const currentRevision = Number(row.revision) > 0 ? Number(row.revision) : 1;
    const nextRevision = currentRevision + 1;
    const fields = input.backLabel || {};
    const categoryId = isHumanProtected(human, "category", "categoryId")
      ? String(row.category_id)
      : clean(input.category) ? resolveCategory(this.db, input.category) : String(row.category_id);
    const confidence = clampConfidence(input.confidence);
    const groupId = existing.group_id;
    const sourceAssetIds = JSON.stringify([...new Set([input.sourceAssetId, input.derivativeAssetId].filter((value): value is string => Boolean(value))) ]);
    const now = new Date().toISOString();

    const productValues = {
      name: mergeText(fields, ["productName", "name"], row.name, human) || "",
      brand: mergeTextAliases(fields, ["brand", "manufacturer"], row.brand, human),
      description: mergeTextAliases(fields, ["description", "netContent"], row.description, human),
      ingredients: mergeText(fields, ["ingredients"], row.ingredients, human),
      efficacy: mergeText(fields, ["efficacy"], row.efficacy, human),
      directions: mergeText(fields, ["directions"], row.directions, human),
      warnings: mergeTextAliases(fields, ["warnings", "allergens"], row.warnings, human),
      countryOfOrigin: mergeText(fields, ["countryOfOrigin"], row.country_of_origin, human),
      manufacturer: mergeText(fields, ["manufacturer"], row.manufacturer, human),
      licenseNumber: mergeText(fields, ["licenseNumber"], row.license_number, human),
      batchNumber: mergeText(fields, ["batchNumber"], row.batch_number, human),
      productionDate: mergeText(fields, ["productionDate"], row.production_date, human),
      shelfLife: mergeText(fields, ["shelfLife"], row.shelf_life, human),
      expiryDate: mergeTextAliases(fields, ["expiry", "expiryDate"], row.expiry_date, human),
    };
    const variants = this.db.prepare("SELECT * FROM product_variants WHERE product_id = ? ORDER BY created_at, id").all(productId) as Array<Record<string, unknown>>;
    const targetVariant = chooseRerunVariant(this.db, productId, input.sourceAssetId, variants);
    const baseVariant = targetVariant || (variants.length === 1 ? variants[0] : undefined);
    const variantValues = buildRerunVariant(fields, baseVariant, human);

    // Use the platform write boundary instead of a raw transaction so a
    // backup/restore maintenance marker cannot begin between validation and
    // the candidate revision commit.
    withTransaction(() => {
      const updated = this.db.prepare(`UPDATE products SET name=?, brand=?, category_id=?, description=?, ingredients=?, efficacy=?, directions=?, warnings=?, country_of_origin=?, manufacturer=?, license_number=?, batch_number=?, production_date=?, shelf_life=?, expiry_date=?, source_group_id=?, status='review_pending', revision=?, reviewed_at=NULL, reviewed_by=NULL, published_at=NULL, updated_at=? WHERE id=? AND revision=? AND status IN ('draft','review_pending','needs_changes')`).run(
        productValues.name, productValues.brand, categoryId, productValues.description, productValues.ingredients, productValues.efficacy, productValues.directions,
        productValues.warnings, productValues.countryOfOrigin, productValues.manufacturer, productValues.licenseNumber, productValues.batchNumber,
        productValues.productionDate, productValues.shelfLife, productValues.expiryDate, row.source_group_id ?? groupId ?? null, nextRevision, now, productId, currentRevision,
      );
      if (!updated.changes) throw catalogCandidateError("CANDIDATE_REVISION_CONFLICT", "Candidate changed while retrying; refresh and try again");

      if (groupId) {
        this.db.prepare("UPDATE candidate_groups SET category_id=?, confidence=CASE WHEN confidence IS NULL OR confidence < ? THEN ? ELSE confidence END, updated_at=? WHERE id=?").run(categoryId, confidence, confidence, now, groupId);
      }
      if (groupId) {
        this.db.prepare("INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) VALUES (?, ?, 'unknown', COALESCE((SELECT MAX(sort_order)+1 FROM group_assets WHERE group_id=?), 0), ?)").run(groupId, input.sourceAssetId, groupId, now);
        if (input.derivativeAssetId) this.db.prepare("INSERT OR IGNORE INTO group_assets (group_id, asset_id, view_type, sort_order, created_at) VALUES (?, ?, 'front', COALESCE((SELECT MAX(sort_order)+1 FROM group_assets WHERE group_id=?), 0), ?)").run(groupId, input.derivativeAssetId, groupId, now);
      }
      this.db.prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, is_primary, sort_order, created_at) VALUES (?, ?, 0, COALESCE((SELECT MAX(sort_order)+1 FROM product_assets WHERE product_id=?), 0), ?)").run(productId, input.sourceAssetId, productId, now);
      if (input.derivativeAssetId) this.db.prepare("INSERT OR IGNORE INTO product_assets (product_id, asset_id, is_primary, sort_order, created_at) VALUES (?, ?, 0, COALESCE((SELECT MAX(sort_order)+1 FROM product_assets WHERE product_id=?), 0), ?)").run(productId, input.derivativeAssetId, productId, now);

      if (targetVariant) {
        this.db.prepare(`UPDATE product_variants SET sku=?, barcode_raw=?, barcode_normalized=?, barcode_symbology=?, barcode_valid=?, specification=?, net_content=?, unit=?, packaging=?, color=?, scent=?, price=?, stock=?, updated_at=? WHERE id=? AND product_id=?`).run(
          variantValues.sku, variantValues.barcodeRaw, variantValues.barcodeNormalized, variantValues.barcodeSymbology, variantValues.barcodeValid,
          variantValues.specification, variantValues.netContent, variantValues.unit, variantValues.packaging, variantValues.color, variantValues.scent,
          variantValues.price, variantValues.stock, now, targetVariant.id, productId,
        );
      } else if (!variants.length || variants.length === 1) {
        this.db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `var-${randomUUID()}`, productId, variantValues.sku, variantValues.barcodeRaw, variantValues.barcodeNormalized, variantValues.barcodeSymbology,
          variantValues.barcodeValid, variantValues.specification, variantValues.netContent, variantValues.unit, variantValues.packaging, variantValues.color,
          variantValues.scent, now, now,
        );
      } else {
        // A grouped product may have one variant per source item. Without a
        // durable item->variant foreign key, append a fresh variant rather
        // than mutating a sibling's projection.
        this.db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode_raw, barcode_normalized, barcode_symbology, barcode_valid, specification, net_content, unit, packaging, color, scent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `var-${randomUUID()}`, productId, variantValues.sku, variantValues.barcodeRaw, variantValues.barcodeNormalized, variantValues.barcodeSymbology,
          variantValues.barcodeValid, variantValues.specification, variantValues.netContent, variantValues.unit, variantValues.packaging, variantValues.color,
          variantValues.scent, now, now,
        );
      }

      const insertEvidence = this.db.prepare("INSERT INTO field_evidence (id, product_id, group_id, field_key, raw_value, normalized_value, confidence, source, state, source_asset_ids_json, ai_run_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'vision', 'suggested', ?, ?, ?, ?)");
      const categoryText = clean(input.category);
      if (categoryText) insertEvidence.run(`evidence-${randomUUID()}`, productId, groupId, "category", categoryText, categoryId, confidence, sourceAssetIds, aiRunId, nextRevision, now);
      for (const [fieldKey, value] of Object.entries(fields)) {
        const text = clean(value);
        if (!text || !/^[A-Za-z0-9_.-]{1,120}$/.test(fieldKey)) continue;
        insertEvidence.run(`evidence-${randomUUID()}`, productId, groupId, fieldKey, text, text, confidence, sourceAssetIds, aiRunId, nextRevision, now);
      }
      this.db.prepare("INSERT INTO candidate_ai_runs (product_id, ai_run_id, item_id, revision, created_at) VALUES (?, ?, ?, ?, ?)").run(productId, aiRunId, input.itemId, nextRevision, now);
    });
    return { productId, groupId: groupId || "", product: getProduct(productId), idempotent: false, revision: nextRevision, aiRunId };
  }

  review(productId: string, actor: { id: string; role: "admin" | "reviewer" }, decision: "approve" | "reject" | "needs_changes", reason?: string, expectedRevision?: number, pipelineSync?: ReviewPipelineSync): ProductRecord {
    return reviewProduct(productId, actor, decision, reason, expectedRevision, pipelineSync);
  }

  /** Persist field-level human edits before the review decision. AI evidence is
   * retained; this creates the normal product revision and never overwrites a
   * value that the reviewer left untouched. */
  applyHumanEdits(productId: string, edits: { category?: string; backLabel?: BackLabelFields }, expectedRevision?: number): ProductRecord {
    const current = getProduct(productId);
    if (!current) throw new Error('商品不存在');
    const fields = edits.backLabel || {};
    const categoryId = edits.category ? resolveCategory(this.db, edits.category) : current.categoryId;
    const variant = current.variants[0] || { specification: '' };
    const hasField = (key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(fields, key);
    const valueOrCurrent = (key: keyof BackLabelFields, current: string | null | undefined): string | null | undefined => hasField(key) ? (fields[key] === '' ? null : fields[key] ?? null) : current;
    const mergedVariant = {
      ...variant,
      sku: valueOrCurrent('sku', variant.sku),
      barcodeRaw: valueOrCurrent('barcode', variant.barcodeRaw),
      netContent: valueOrCurrent('netContent', variant.netContent),
      unit: valueOrCurrent('unit', variant.unit),
      packaging: valueOrCurrent('packaging', variant.packaging),
      color: valueOrCurrent('color', variant.color),
      scent: valueOrCurrent('scent', variant.scent),
      specification: hasField('netContent')
        ? (fields.netContent?.trim() || '')
        : variant.specification || '',
    };
    const variants = current.variants.length > 0
      ? current.variants.map((entry, index) => index === 0 ? mergedVariant : entry)
      : [mergedVariant];
    const updated = updateProduct(productId, {
      ...current,
      // AI candidates retain source and derivative evidence exactly as linked.
      // Human field edits must not reinterpret those relations as a manual
      // image replacement request.
      assetIds: undefined,
      categoryId,
      name: hasField('productName') ? (fields.productName?.trim() || '') : current.name,
      brand: valueOrCurrent('brand', current.brand),
      ingredients: valueOrCurrent('ingredients', current.ingredients),
      efficacy: valueOrCurrent('efficacy', current.efficacy),
      directions: valueOrCurrent('directions', current.directions),
      warnings: hasField('allergens') ? (fields.allergens === '' ? null : fields.allergens ?? null) : hasField('warnings') ? (fields.warnings === '' ? null : fields.warnings ?? null) : current.warnings,
      manufacturer: valueOrCurrent('manufacturer', current.manufacturer),
      countryOfOrigin: valueOrCurrent('countryOfOrigin', current.countryOfOrigin),
      licenseNumber: valueOrCurrent('licenseNumber', current.licenseNumber),
      batchNumber: valueOrCurrent('batchNumber', current.batchNumber),
      productionDate: valueOrCurrent('productionDate', current.productionDate),
      shelfLife: valueOrCurrent('shelfLife', current.shelfLife),
      expiryDate: valueOrCurrent('expiry', current.expiryDate),
      variants,
    }, expectedRevision);

    // AI evidence is immutable history. Each human-submitted value gets a
    // new accepted/not_found evidence row at the resulting product revision;
    // it never mutates or overwrites the suggestion rows.
    const evidenceEntries: Array<[string, string | null]> = [['category', edits.category || null]];
    for (const [key, value] of Object.entries(fields)) evidenceEntries.push([key, clean(value)]);
    const timestamp = new Date().toISOString();
    withTransaction((db) => {
      const insert = db.prepare(`INSERT INTO field_evidence
        (id, product_id, group_id, field_key, raw_value, normalized_value, confidence, source, state, source_asset_ids_json, revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 'human', ?, '[]', ?, ?)`);
      for (const [fieldKey, value] of evidenceEntries) {
        if (!fieldKey || !/^[A-Za-z0-9_.-]{1,120}$/.test(fieldKey)) continue;
        insert.run(`evidence-${randomUUID()}`, productId, updated.sourceGroupId ?? null, fieldKey, value, value, value ? 'accepted' : 'not_found', updated.revision, timestamp);
      }
    });
    return updated;
  }
}

const EDITABLE_CANDIDATE_STATUSES = new Set(["draft", "review_pending", "needs_changes"]);

function normalizeAiRunId(value: unknown): string | undefined {
  const text = clean(value, 180);
  return text && /^[A-Za-z0-9._:-]{1,180}$/.test(text) ? text : undefined;
}

function catalogCandidateError(code: string, message: string): Error & { code: string; class: "validation"; retryable: false; status?: number } {
  const error = new Error(message) as Error & { code: string; class: "validation"; retryable: false; status?: number };
  error.name = code;
  error.code = code;
  error.class = "validation";
  error.retryable = false;
  if (code.includes("PUBLISHED") || code.includes("CONFLICT")) error.status = 409;
  return error;
}

/** Return the latest accepted/not-found human decision for each field.  The
 * product row already contains the resulting value, so the set is all that
 * is needed to fence a later AI projection. */
function latestHumanEvidence(db: SqliteDatabase, productId: string): Set<string> {
  const rows = db.prepare("SELECT field_key, state, revision, created_at FROM field_evidence WHERE product_id = ? AND source = 'human' ORDER BY revision DESC, created_at DESC").all(productId) as Array<{ field_key: string; state: string }>;
  const protectedFields = new Set<string>();
  const seenFields = new Set<string>();
  for (const row of rows) {
    if (seenFields.has(row.field_key)) continue;
    seenFields.add(row.field_key);
    if (row.state === "accepted" || row.state === "not_found") protectedFields.add(row.field_key);
  }
  return protectedFields;
}

function isHumanProtected(fields: Set<string>, ...keys: string[]): boolean {
  return keys.some((key) => fields.has(key));
}

function fieldValue(fields: BackLabelFields, key: string): unknown {
  return (fields as Record<string, unknown>)[key];
}

function mergeText(fields: BackLabelFields, keys: string[], current: unknown, human: Set<string>): string | null {
  if (isHumanProtected(human, ...keys)) return clean(current);
  for (const key of keys) {
    const candidate = clean(fieldValue(fields, key));
    if (candidate) return candidate;
  }
  return clean(current);
}

function mergeTextAliases(fields: BackLabelFields, keys: string[], current: unknown, human: Set<string>): string | null {
  return mergeText(fields, keys, current, human);
}

interface RerunVariantValues {
  sku: string | null;
  barcodeRaw: string | null;
  barcodeNormalized: string | null;
  barcodeSymbology: 'EAN_13' | 'UPC_A' | 'CODE_128' | 'UNKNOWN' | null;
  barcodeValid: number | null;
  specification: string;
  netContent: string | null;
  unit: string | null;
  packaging: string | null;
  color: string | null;
  scent: string | null;
  price: number | null;
  stock: number | null;
}

function buildRerunVariant(fields: BackLabelFields, base: Record<string, unknown> | undefined, human: Set<string>): RerunVariantValues {
  const current = (key: string): unknown => base?.[key];
  const sku = mergeText(fields, ["sku"], current("sku"), human);
  const barcodeRaw = mergeText(fields, ["barcode", "barcodeRaw"], current("barcode_raw"), human);
  const parsedBarcode = barcodeRaw ? normalizeBarcode(barcodeRaw) : undefined;
  const barcodeNormalized = parsedBarcode?.normalized || clean(current("barcode_normalized"), 128);
  const barcodeSymbology = parsedBarcode?.symbology || asBarcodeSymbology(current("barcode_symbology"));
  const barcodeValid = parsedBarcode
    ? (parsedBarcode.checksumValid == null ? null : parsedBarcode.checksumValid ? 1 : 0)
    : asNullableBoolean(current("barcode_valid"));
  const netContent = mergeText(fields, ["netContent"], current("net_content"), human);
  const unit = mergeText(fields, ["unit"], current("unit"), human);
  const packaging = mergeText(fields, ["packaging"], current("packaging"), human);
  const color = mergeText(fields, ["color"], current("color"), human);
  const scent = mergeText(fields, ["scent"], current("scent"), human);
  const specification = mergeText(fields, ["specification", "netContent", "packaging", "unit"], current("specification"), human) || "";
  return {
    sku, barcodeRaw, barcodeNormalized, barcodeSymbology, barcodeValid, specification,
    netContent, unit, packaging, color, scent,
    price: nonNegativeNumber(mergeNumber(fields, ["price"], current("price"), human)),
    stock: nonNegativeInteger(mergeNumber(fields, ["stock"], current("stock"), human)),
  };
}

function mergeNumber(fields: BackLabelFields, keys: string[], current: unknown, human: Set<string>): number | null {
  if (isHumanProtected(human, ...keys)) return asNullableNumber(current);
  for (const key of keys) {
    const candidate = asNullableNumber(fieldValue(fields, key));
    if (candidate != null) return candidate;
  }
  return asNullableNumber(current);
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asNullableBoolean(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

function nonNegativeNumber(value: number | null): number | null {
  return value == null ? null : Math.max(0, value);
}

function nonNegativeInteger(value: number | null): number | null {
  return value == null ? null : Math.max(0, Math.floor(value));
}

function asBarcodeSymbology(value: unknown): RerunVariantValues['barcodeSymbology'] {
  return value === 'EAN_13' || value === 'UPC_A' || value === 'CODE_128' || value === 'UNKNOWN' ? value : null;
}

function chooseRerunVariant(db: SqliteDatabase, productId: string, sourceAssetId: string, variants: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  if (variants.length <= 1) return variants[0];
  if (!sourceAssetId) return undefined;
  const rows = db.prepare("SELECT field_key, raw_value, normalized_value, source_asset_ids_json FROM field_evidence WHERE product_id = ? AND source = 'vision' ORDER BY revision DESC, created_at DESC").all(productId) as Array<{ field_key: string; raw_value: string | null; normalized_value: string | null; source_asset_ids_json: string }>;
  const expected = new Map<string, string>();
  for (const row of rows) {
    if (expected.has(row.field_key)) continue;
    if (!parseStringArray(row.source_asset_ids_json).includes(sourceAssetId)) continue;
    const value = clean(row.normalized_value ?? row.raw_value, 256);
    if (value) expected.set(row.field_key, value.toLowerCase());
  }
  if (!expected.size) return undefined;
  let best: Record<string, unknown> | undefined;
  let bestScore = 0;
  for (const variant of variants) {
    let score = 0;
    const pairs: Array<[string, unknown]> = [
      ['sku', variant.sku], ['barcode', variant.barcode_normalized ?? variant.barcode_raw], ['netContent', variant.net_content],
      ['unit', variant.unit], ['packaging', variant.packaging], ['color', variant.color], ['scent', variant.scent],
    ];
    for (const [key, value] of pairs) if (expected.get(key) && clean(value, 256)?.toLowerCase() === expected.get(key)) score += 1;
    if (score > bestScore) { best = variant; bestScore = score; }
  }
  return best;
}

export function resolveCategory(db: SqliteDatabase, value?: string): string {
  const raw = clean(value);
  if (raw) {
    const row = db.prepare("SELECT id FROM taxonomy_categories WHERE active = 1 AND (id = ? OR code = ? OR name = ?) LIMIT 1").get(raw, raw.toLowerCase(), raw) as { id: string } | undefined;
    if (row) return row.id;
    const fuzzy = db.prepare("SELECT id FROM taxonomy_categories WHERE active = 1 AND (name LIKE ? OR code LIKE ?) ORDER BY sort_order LIMIT 1").get(`%${raw}%`, `%${raw.toLowerCase()}%`) as { id: string } | undefined;
    if (fuzzy) return fuzzy.id;
  }
  const fallback = db.prepare("SELECT id FROM taxonomy_categories WHERE code = 'pending' AND active = 1 LIMIT 1").get() as { id: string } | undefined;
  if (!fallback) throw new Error("No active fallback taxonomy category exists");
  return fallback.id;
}

function clean(value: unknown, max = 4_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
function clampConfidence(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}
