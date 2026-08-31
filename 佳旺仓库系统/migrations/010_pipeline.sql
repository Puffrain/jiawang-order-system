-- Pipeline persistence contract. Domain state is kept in normalized tables for
-- inspection/migrations; the development PipelineStore may additionally use
-- the pipeline_state snapshot table through SqliteStateBackend.
CREATE TABLE IF NOT EXISTS pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_uploads (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('created','uploading','completed','failed','cancelled')),
  chunk_dir TEXT NOT NULL,
  expected_bytes INTEGER,
  expected_chunks INTEGER,
  chunk_size INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  received_chunks_json TEXT NOT NULL DEFAULT '[]',
  original_asset_id TEXT,
  original_path TEXT,
  sha256 TEXT,
  filename TEXT,
  mime_type TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  pixels INTEGER,
  has_exif INTEGER,
  source_asset_id TEXT,
  derivative_kind TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (sha256)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelling','cancelled','succeeded','failed')),
  source_asset_id TEXT,
  upload_id TEXT,
  provider TEXT NOT NULL,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_acquired_at TEXT,
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER,
  estimated_cost_minor INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  derivative_asset_id TEXT,
  candidate_product_id TEXT,
  candidate_group_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','needs_review','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_acquired_at TEXT,
  lease_expires_at TEXT,
  category TEXT,
  group_name TEXT,
  back_label_json TEXT,
  confidence REAL,
  ai_raw_json TEXT,
  manual_required INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  updated_at TEXT NOT NULL
  -- job/source rows may live in the durable pipeline snapshot backend; the
  -- IDs are validated by the worker before projection.
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_job_id ON pipeline_events(job_id, id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_import_items_job_status ON import_items(job_id, status);

CREATE TABLE IF NOT EXISTS pipeline_candidate_links (
  item_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  group_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES candidate_groups(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_candidate_group_pending ON candidate_groups(job_id, name) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pipeline_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reserve','settle','pause','refund')),
  tokens INTEGER NOT NULL,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_ledger_task ON token_ledger(task_id, at);

CREATE TABLE IF NOT EXISTS pipeline_budget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
