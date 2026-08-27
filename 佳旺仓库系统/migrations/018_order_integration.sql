CREATE TABLE IF NOT EXISTS order_sync_outbox (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
  revision INTEGER NOT NULL, event_type TEXT, payload_hash TEXT, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','dead','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT, delivered_at TEXT, superseded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(product_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_order_sync_due ON order_sync_outbox(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_order_sync_product_revision ON order_sync_outbox(product_id,revision DESC);

CREATE TABLE IF NOT EXISTS inventory_operations (
  operation_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reserve','release')),
  related_operation_id TEXT, lines_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id,kind)
);
