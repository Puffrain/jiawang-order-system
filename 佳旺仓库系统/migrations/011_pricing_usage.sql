-- Versioned provider pricing and normalized usage projections.  The JSON
-- ledger remains the source of truth for backwards-compatible local stores;
-- these tables make reservations/settlements queryable and auditable.
CREATE TABLE IF NOT EXISTS pricing_versions (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  version TEXT NOT NULL,
  currency TEXT NOT NULL,
  prompt_price_minor INTEGER NOT NULL,
  completion_price_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model, version)
);

CREATE TABLE IF NOT EXISTS token_reservations (
  task_id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  usage_known INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  price_version TEXT,
  currency TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  usage_known INTEGER NOT NULL DEFAULT 0,
  price_version TEXT,
  currency TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_task ON usage_ledger(task_id, at);
