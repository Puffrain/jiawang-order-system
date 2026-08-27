-- Durable idempotency markers for candidate AI generations.  A model may
-- legitimately return no category or back-label fields; field_evidence then
-- has no row to identify the generation.  Keep the execution marker separate
-- from user-visible evidence so replay never increments a product revision.
CREATE TABLE IF NOT EXISTS candidate_ai_runs (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ai_run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_id, ai_run_id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_ai_runs_item ON candidate_ai_runs(item_id, created_at DESC);
