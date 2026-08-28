-- Order lifecycle v2: additive, replay-safe schema migration.
ALTER TABLE orders ADD COLUMN order_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN merchant_confirmed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN buyer_confirmed_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN confirmation_status TEXT NOT NULL DEFAULT 'merchant_review';
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN payment_method TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
ALTER TABLE orders ADD COLUMN fulfillment_method TEXT NOT NULL DEFAULT 'express';
ALTER TABLE orders ADD COLUMN customer_hidden_at TEXT;
ALTER TABLE orders ADD COLUMN migration_source TEXT;
CREATE TABLE IF NOT EXISTS order_revisions (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, reason TEXT NOT NULL, actor_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(order_id, version)
);
CREATE INDEX IF NOT EXISTS idx_order_revisions_order ON order_revisions(order_id, version);
UPDATE orders SET migration_source=COALESCE(migration_source, 'legacy-order-schema');
INSERT OR IGNORE INTO schema_migrations(version) VALUES('001_order_lifecycle_v2');
