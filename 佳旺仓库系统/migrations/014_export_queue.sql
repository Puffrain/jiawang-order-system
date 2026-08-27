-- Durable export queue leases and resource budgets.  The lease columns make a
-- running export recoverable after a worker crash; the limits are captured on
-- each row so changing environment defaults cannot enlarge an existing job.
ALTER TABLE export_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE export_jobs ADD COLUMN lease_acquired_at TEXT;
ALTER TABLE export_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE export_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE export_jobs ADD COLUMN max_rows INTEGER NOT NULL DEFAULT 100000 CHECK (max_rows > 0);
ALTER TABLE export_jobs ADD COLUMN max_bytes INTEGER NOT NULL DEFAULT 268435456 CHECK (max_bytes > 0);

CREATE INDEX IF NOT EXISTS idx_export_jobs_queue
  ON export_jobs(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_requested_queue
  ON export_jobs(requested_by, status, created_at);
