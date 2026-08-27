import { EMPTY_PIPELINE_STATE, PipelineStoreState } from "../contracts/pipeline";
import { acquireWriteLease, releaseWriteLease } from "../maintenance";

export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number } };
  transaction<T>(fn: () => T): () => T;
}
interface SqliteStatement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number } }

/** Pluggable durable state boundary; PipelineStore remains the domain API. */
export interface PipelineStateBackend {
  load(): PipelineStoreState | undefined;
  save(state: PipelineStoreState): void;
}

/**
 * SQLite backend backed by the platform's better-sqlite3 connection. It keeps
 * one atomically replaced JSON snapshot in a migration-owned table while the
 * domain methods continue to enforce leases/transitions. This is deliberately
 * dependency-free (the `db` value is duck-typed) and works with the platform
 * `getDb()` export without importing or changing lib/db.ts.
 */
export class SqliteStateBackend implements PipelineStateBackend {
  private readonly readStatement: SqliteStatement;
  private revision = 0;
  constructor(private readonly db: SqliteLike) {
    if (!db || typeof db.prepare !== "function") throw new Error("A better-sqlite3 compatible database is required");
    db.exec("CREATE TABLE IF NOT EXISTS pipeline_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const columns = db.prepare("PRAGMA table_info(pipeline_state)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "revision")) db.exec("ALTER TABLE pipeline_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    this.readStatement = db.prepare("SELECT revision, state_json FROM pipeline_state WHERE id = 1");
  }
  load(): PipelineStoreState | undefined {
    const row = this.readStatement.get() as { revision: number; state_json: string } | undefined;
    if (!row) { this.revision = 0; return undefined; }
    this.revision = Number(row.revision) || 0;
    try {
      const parsed = JSON.parse(row.state_json);
      if (parsed?.version !== 1) throw new Error("Unsupported pipeline state version");
      const jobs = parsed.jobs || {};
      for (const job of Object.values(jobs) as Array<{ stage?: string }>) if (!job.stage) job.stage = 'queued';
      parsed.jobs = jobs;
      return parsed as PipelineStoreState;
    } catch (error) {
      throw new Error(`Invalid pipeline_state JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  save(state: PipelineStoreState): void {
    const expected = this.revision;
    const payload = JSON.stringify(state);
    const lease = acquireWriteLease('pipeline.state');
    try { this.db.transaction(() => {
      const current = this.db.prepare("SELECT revision FROM pipeline_state WHERE id = 1").get() as { revision: number } | undefined;
      if (!current) {
        if (expected !== 0) throw stateConflict();
        this.db.prepare("INSERT INTO pipeline_state (id, version, revision, state_json, updated_at) VALUES (1, 1, 1, ?, datetime('now'))").run(payload);
        this.revision = 1;
        projectNormalizedState(this.db, state);
        return;
      }
      if (Number(current.revision) !== expected) throw stateConflict();
      const result = this.db.prepare("UPDATE pipeline_state SET version = 1, revision = revision + 1, state_json = ?, updated_at = datetime('now') WHERE id = 1 AND revision = ?").run(payload, expected);
      if (result.changes !== 1) throw stateConflict();
      this.revision = expected + 1;
      projectNormalizedState(this.db, state);
    })(); } finally { releaseWriteLease(lease); }
  }
}

/** Mirror the durable JSON domain snapshot into the normalized inspection
 * tables declared by migration 010. The snapshot remains the CAS source of
 * truth; this projection is rebuilt in the same SQLite transaction so direct
 * operators, reporting queries and recovery manifests never observe a half
 * updated job/item/asset row. */
function projectNormalizedState(db: SqliteLike, state: PipelineStoreState): void {
  const uploads = Object.values(state.uploads);
  const assets = Object.values(state.assets);
  const jobs = Object.values(state.jobs);
  const items = Object.values(state.items);
  const groups = Object.values(state.groups);
  const events = state.events;

  const uploadIds = new Set(uploads.map((value) => value.id));
  const assetIds = new Set(assets.map((value) => value.id));
  const jobIds = new Set(jobs.map((value) => value.id));
  const itemIds = new Set(items.map((value) => value.id));
  const groupIds = new Set(groups.map((value) => value.id));
  const eventIds = new Set(events.map((value) => value.id));
  deleteMissing(db, 'pipeline_uploads', uploadIds);
  deleteMissing(db, 'pipeline_assets', assetIds);
  deleteMissing(db, 'import_jobs', jobIds);
  deleteMissing(db, 'import_items', itemIds);
  deleteMissing(db, 'pipeline_groups', groupIds);
  deleteMissing(db, 'pipeline_events', eventIds);

  const upsertUpload = db.prepare(`INSERT INTO pipeline_uploads
    (id,status,chunk_dir,expected_bytes,expected_chunks,chunk_size,received_bytes,received_chunks_json,original_asset_id,original_path,sha256,filename,mime_type,error_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,chunk_dir=excluded.chunk_dir,expected_bytes=excluded.expected_bytes,expected_chunks=excluded.expected_chunks,chunk_size=excluded.chunk_size,received_bytes=excluded.received_bytes,received_chunks_json=excluded.received_chunks_json,original_asset_id=excluded.original_asset_id,original_path=excluded.original_path,sha256=excluded.sha256,filename=excluded.filename,mime_type=excluded.mime_type,error_json=excluded.error_json,updated_at=excluded.updated_at`);
  for (const upload of uploads) upsertUpload.run(upload.id, upload.status, upload.chunkDir, upload.expectedBytes ?? null, upload.expectedChunks ?? null, upload.chunkSize, upload.receivedBytes, JSON.stringify(upload.receivedChunks), upload.originalAssetId ?? null, upload.originalPath ?? null, upload.sha256 ?? null, upload.filename ?? null, upload.mimeType ?? null, jsonOrNull(upload.error), upload.createdAt, upload.updatedAt);

  const upsertAsset = db.prepare(`INSERT INTO pipeline_assets
    (id,sha256,path,filename,mime_type,bytes,width,height,pixels,has_exif,source_asset_id,derivative_kind,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,path=excluded.path,filename=excluded.filename,mime_type=excluded.mime_type,bytes=excluded.bytes,width=excluded.width,height=excluded.height,pixels=excluded.pixels,has_exif=excluded.has_exif,source_asset_id=excluded.source_asset_id,derivative_kind=excluded.derivative_kind`);
  const seenDigests = new Set<string>();
  for (const asset of assets) {
    // The normalized table enforces SHA uniqueness. Keep the first immutable
    // record if a legacy snapshot contains duplicate IDs/digests.
    if (seenDigests.has(asset.sha256)) continue;
    seenDigests.add(asset.sha256);
    upsertAsset.run(asset.id, asset.sha256, asset.path, asset.filename, asset.mimeType, asset.bytes, asset.width ?? null, asset.height ?? null, asset.pixels ?? null, asset.hasExif == null ? null : asset.hasExif ? 1 : 0, asset.sourceAssetId ?? null, asset.derivativeKind ?? null, asset.createdAt);
  }

  const upsertJob = db.prepare(`INSERT INTO import_jobs
    (id,status,stage,source_asset_id,upload_id,provider,ai_profile_id,ai_profile_revision_id,ai_config_snapshot,ai_profile_name,ai_model,ai_profile_revision,ai_version_fingerprint,item_ids_json,total_items,completed_items,failed_items,lease_owner,lease_acquired_at,lease_expires_at,cancel_requested,reserved_tokens,used_tokens,estimated_cost_minor,error_json,pending_budget_refund,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,stage=excluded.stage,source_asset_id=excluded.source_asset_id,upload_id=excluded.upload_id,provider=excluded.provider,ai_profile_id=excluded.ai_profile_id,ai_profile_revision_id=excluded.ai_profile_revision_id,ai_config_snapshot=excluded.ai_config_snapshot,ai_profile_name=excluded.ai_profile_name,ai_model=excluded.ai_model,ai_profile_revision=excluded.ai_profile_revision,ai_version_fingerprint=excluded.ai_version_fingerprint,item_ids_json=excluded.item_ids_json,total_items=excluded.total_items,completed_items=excluded.completed_items,failed_items=excluded.failed_items,lease_owner=excluded.lease_owner,lease_acquired_at=excluded.lease_acquired_at,lease_expires_at=excluded.lease_expires_at,cancel_requested=excluded.cancel_requested,reserved_tokens=excluded.reserved_tokens,used_tokens=excluded.used_tokens,estimated_cost_minor=excluded.estimated_cost_minor,error_json=excluded.error_json,pending_budget_refund=excluded.pending_budget_refund,updated_at=excluded.updated_at`);
  for (const job of jobs) upsertJob.run(job.id, job.status, job.stage || 'queued', job.sourceAssetId ?? null, job.uploadId ?? null, job.provider, job.aiProfileId ?? null, job.aiProfileRevisionId ?? null, job.aiConfigSnapshot ?? null, job.aiProfileName ?? null, job.aiModel ?? null, job.aiProfileRevision ?? null, job.aiVersionFingerprint ?? null, JSON.stringify(job.itemIds), job.totalItems, job.completedItems, job.failedItems, job.lease?.owner ?? null, job.lease?.acquiredAt ?? null, job.lease?.expiresAt ?? null, job.cancelRequested ? 1 : 0, job.reservedTokens, job.usedTokens ?? null, job.estimatedCostMinor ?? null, jsonOrNull(job.error), job.pendingBudgetRefund ?? null, job.createdAt, job.updatedAt);

  const upsertItem = db.prepare(`INSERT INTO import_items
    (id,job_id,source_asset_id,derivative_asset_id,candidate_product_id,candidate_group_id,status,attempts,lease_owner,lease_acquired_at,lease_expires_at,category,group_name,back_label_json,confidence,ai_raw_json,manual_required,error_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,source_asset_id=excluded.source_asset_id,derivative_asset_id=excluded.derivative_asset_id,candidate_product_id=excluded.candidate_product_id,candidate_group_id=excluded.candidate_group_id,status=excluded.status,attempts=excluded.attempts,lease_owner=excluded.lease_owner,lease_acquired_at=excluded.lease_acquired_at,lease_expires_at=excluded.lease_expires_at,category=excluded.category,group_name=excluded.group_name,back_label_json=excluded.back_label_json,confidence=excluded.confidence,ai_raw_json=excluded.ai_raw_json,manual_required=excluded.manual_required,error_json=excluded.error_json,updated_at=excluded.updated_at`);
  for (const item of items) upsertItem.run(item.id, item.jobId, item.sourceAssetId, item.derivativeAssetId ?? null, item.candidateProductId ?? null, item.candidateGroupId ?? null, item.status, item.attempts, item.lease?.owner ?? null, item.lease?.acquiredAt ?? null, item.lease?.expiresAt ?? null, item.category ?? null, item.group ?? null, item.backLabel ? JSON.stringify(item.backLabel) : null, item.confidence ?? null, item.aiRaw ? JSON.stringify(item.aiRaw) : null, item.manualRequired ? 1 : 0, jsonOrNull(item.error), item.updatedAt);

  const upsertGroup = db.prepare(`INSERT INTO pipeline_groups (id,name,category,item_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,item_ids_json=excluded.item_ids_json,updated_at=excluded.updated_at`);
  for (const group of groups) upsertGroup.run(group.id, group.name, group.category ?? null, JSON.stringify(group.itemIds), group.createdAt, group.updatedAt);

  const upsertEvent = db.prepare(`INSERT OR REPLACE INTO pipeline_events (id,job_id,type,at,data_json) VALUES (?,?,?,?,?)`);
  for (const event of events) upsertEvent.run(event.id, event.jobId, event.type, event.at, JSON.stringify(event.data));
}

function deleteMissing(db: SqliteLike, table: string, ids: Set<string | number>): void {
  if (!ids.size) { db.prepare(`DELETE FROM ${table}`).run(); return; }
  const placeholders = [...ids].map(() => '?').join(',');
  db.prepare(`DELETE FROM ${table} WHERE id NOT IN (${placeholders})`).run(...ids);
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

export function emptyState(): PipelineStoreState {
  return JSON.parse(JSON.stringify(EMPTY_PIPELINE_STATE));
}

function stateConflict(): Error & { code: string; class: string; retryable: boolean } {
  const error = new Error("Pipeline state changed concurrently; retry the operation") as Error & { code: string; class: string; retryable: boolean };
  error.code = "STATE_CONFLICT";
  error.class = "io";
  error.retryable = true;
  return error;
}
