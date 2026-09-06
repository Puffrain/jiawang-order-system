-- WeChat Pay API v3: additive, replay-safe payment and refund records.
CREATE TABLE IF NOT EXISTS wechat_payment_intents (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, order_version INTEGER NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE, amount_fen INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created',
  prepay_id TEXT, transaction_id TEXT UNIQUE, payer_openid TEXT NOT NULL,
  expires_at TEXT, paid_at TEXT, failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, order_version)
);
CREATE INDEX IF NOT EXISTS idx_wechat_payment_order ON wechat_payment_intents(order_id, status, updated_at);
CREATE TABLE IF NOT EXISTS wechat_refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payment_intent_id TEXT NOT NULL,
  out_refund_no TEXT NOT NULL UNIQUE, refund_id TEXT UNIQUE, amount_fen INTEGER NOT NULL,
  total_fen INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'created',
  success_at TEXT, failure_code TEXT, requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id)
);
CREATE INDEX IF NOT EXISTS idx_wechat_refund_order ON wechat_refunds(order_id, status, updated_at);
CREATE TABLE IF NOT EXISTS wechat_pay_notifications (
  notification_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, resource_type TEXT NOT NULL,
  resource_id TEXT, payload_hash TEXT NOT NULL, processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE orders ADD COLUMN wechat_transaction_id TEXT;
ALTER TABLE orders ADD COLUMN refunded_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_wechat_transaction ON orders(wechat_transaction_id) WHERE wechat_transaction_id IS NOT NULL;
INSERT OR IGNORE INTO schema_migrations(version) VALUES('002_wechat_payments');
