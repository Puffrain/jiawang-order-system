-- Review projection rows that cannot be reconciled with the pipeline are
-- retained for administrator repair instead of retrying forever.  A dead
-- letter is intentionally separate from processed_at so the original outbox
-- payload and attempt history remain auditable.
ALTER TABLE review_sync_outbox ADD COLUMN dead_letter_at TEXT;
ALTER TABLE review_sync_outbox ADD COLUMN dead_letter_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_review_sync_pending_live
  ON review_sync_outbox(processed_at, dead_letter_at, created_at);
