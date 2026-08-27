-- Expired export cleanup is a durable, reclaimable operation.  The cleanup
-- owner prevents two workers from deleting/forgetting an artifact under
-- different assumptions; an expired claim is safe to retry because deletion
-- and the final owner-conditional row removal are idempotent.
ALTER TABLE export_jobs ADD COLUMN cleanup_owner TEXT;
ALTER TABLE export_jobs ADD COLUMN cleanup_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_export_jobs_cleanup
  ON export_jobs(status, completed_at, cleanup_expires_at);
