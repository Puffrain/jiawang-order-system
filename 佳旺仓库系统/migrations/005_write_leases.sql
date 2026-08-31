-- Cross-process request write leases. Backup/restore enters maintenance and
-- waits for these short-lived leases before taking a snapshot or switching
-- the database. Leases are independently recoverable after a process crash.
CREATE TABLE IF NOT EXISTS write_leases (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_write_leases_expiry ON write_leases(expires_at);
