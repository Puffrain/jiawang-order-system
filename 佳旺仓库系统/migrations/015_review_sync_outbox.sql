-- Review decisions update the catalog projection and the import pipeline
-- projection. The outbox row is written in the same catalog transaction so a
-- crash after publish can be reconciled by the worker without guessing.
ALTER TABLE import_jobs ADD COLUMN pending_budget_refund TEXT;

CREATE TABLE IF NOT EXISTS review_sync_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  target_status TEXT NOT NULL CHECK (target_status IN ('succeeded', 'failed', 'needs_review')),
  patch_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_sync_pending ON review_sync_outbox(processed_at, created_at);
