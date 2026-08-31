-- Backup requests keep only a master-key-encrypted passphrase while a job is
-- queued. The plaintext passphrase is never written to SQLite, logs or the
-- resulting archive and the row is removed after processing.
CREATE TABLE IF NOT EXISTS backup_secrets (
  backup_job_id TEXT PRIMARY KEY NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  encrypted_passphrase TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','validating','maintenance','completed','failed')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  input_path TEXT NOT NULL,
  passphrase_ciphertext TEXT NOT NULL,
  recovery_backup_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_status ON restore_jobs(status, updated_at);
