-- Product library, taxonomy, candidate groups and immutable review evidence.
CREATE TABLE IF NOT EXISTS taxonomy_categories (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES taxonomy_categories(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_parent ON taxonomy_categories(parent_id, active, sort_order);

CREATE TABLE IF NOT EXISTS candidate_groups (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT,
  name TEXT NOT NULL,
  category_id TEXT REFERENCES taxonomy_categories(id) ON DELETE SET NULL,
  match_source TEXT NOT NULL DEFAULT 'vision' CHECK (match_source IN ('barcode', 'identity', 'vision', 'human')),
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'split', 'merged', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_job ON candidate_groups(job_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS group_assets (
  group_id TEXT NOT NULL REFERENCES candidate_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  view_type TEXT NOT NULL DEFAULT 'unknown' CHECK (view_type IN ('front', 'back', 'side', 'detail', 'unknown')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, asset_id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  category_id TEXT NOT NULL REFERENCES taxonomy_categories(id) ON DELETE RESTRICT,
  subcategory_id TEXT REFERENCES taxonomy_categories(id) ON DELETE RESTRICT,
  description TEXT,
  ingredients TEXT,
  efficacy TEXT,
  directions TEXT,
  warnings TEXT,
  country_of_origin TEXT,
  manufacturer TEXT,
  license_number TEXT,
  batch_number TEXT,
  production_date TEXT,
  shelf_life TEXT,
  expiry_date TEXT,
  notes TEXT,
  source_group_id TEXT REFERENCES candidate_groups(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_pending', 'needs_changes', 'approved', 'published', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, status);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT,
  barcode_raw TEXT,
  barcode_normalized TEXT,
  barcode_symbology TEXT CHECK (barcode_symbology IS NULL OR barcode_symbology IN ('EAN_13', 'UPC_A', 'CODE_128', 'UNKNOWN')),
  barcode_valid INTEGER CHECK (barcode_valid IS NULL OR barcode_valid IN (0, 1)),
  specification TEXT NOT NULL,
  net_content TEXT,
  unit TEXT,
  packaging TEXT,
  color TEXT,
  scent TEXT,
  price REAL CHECK (price IS NULL OR price >= 0),
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_barcode ON product_variants(barcode_normalized);

CREATE TABLE IF NOT EXISTS product_assets (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, asset_id)
);

CREATE TABLE IF NOT EXISTS field_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES candidate_groups(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  raw_value TEXT,
  normalized_value TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source TEXT NOT NULL CHECK (source IN ('vision', 'barcode', 'human', 'import')),
  state TEXT NOT NULL CHECK (state IN ('suggested', 'accepted', 'rejected', 'not_found', 'conflict')),
  source_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  source_region_json TEXT,
  ai_run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_product ON field_evidence(product_id, field_key, revision DESC);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'needs_changes')),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON review_decisions(product_id, revision DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'xlsx', 'image_manifest')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filter_json TEXT NOT NULL DEFAULT '{}',
  output_path TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS backup_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'maintenance', 'completed', 'failed')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  manifest_json TEXT,
  output_path TEXT,
  bytes INTEGER,
  sha256 TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT OR IGNORE INTO taxonomy_categories (id, code, name, parent_id, active, sort_order, created_at, updated_at) VALUES
  ('cat-hair-color', 'hair-color', '染发', NULL, 1, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-wash-care', 'wash-care', '洗护', NULL, 1, 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-hair-care', 'hair-care', '护发', NULL, 1, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-perm', 'perm', '烫发', NULL, 1, 40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-styling', 'styling', '造型', NULL, 1, 50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-beauty', 'beauty', '美容护肤', NULL, 1, 60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-tools', 'tools', '工具', NULL, 1, 70, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-consumables', 'consumables', '耗材', NULL, 1, 80, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat-pending', 'pending', '待定', NULL, 1, 999, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
