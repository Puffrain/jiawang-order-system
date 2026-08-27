CREATE TABLE IF NOT EXISTS api_idempotency (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  status_code INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_expiry ON api_idempotency(expires_at);
