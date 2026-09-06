-- Full WeChat refunds are terminal: one order may have only one refund record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wechat_refund_one_per_order ON wechat_refunds(order_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES('003_wechat_refund_single_order');
