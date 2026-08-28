import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

function databasePath() {
  const configured = process.env.DATABASE_URL?.replace(/^file:/, "");
  return configured || path.join(process.cwd(), "data", "app.db");
}

const filePath = databasePath();
fs.mkdirSync(path.dirname(filePath), { recursive: true });

const db = new Database(filePath, { timeout: 5000 });
db.pragma("busy_timeout = 10000");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Web, workers and Next build workers may cold-start against the same file.
// Serialize the complete bootstrap so guarded ALTER TABLE statements cannot
// race after two processes observe the same pre-migration schema.
db.exec("BEGIN IMMEDIATE");
try {
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, phone TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'buyer',
    display_name TEXT, status TEXT NOT NULL DEFAULT 'active', password_hash TEXT,
    tour_completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, revoked_at TEXT, ip_hash TEXT, user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rate_limit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limit_events_lookup ON rate_limit_events(bucket,key_hash,created_at);
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, actor_role TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL, object_type TEXT, object_id TEXT, metadata_json TEXT,
    ip_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  CREATE TABLE IF NOT EXISTS owner_phone_aliases (
    phone TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_owner_phone_aliases_user ON owner_phone_aliases(owner_user_id);
  CREATE TABLE IF NOT EXISTS owner_secret_state (
    owner_user_id TEXT PRIMARY KEY, password_fingerprint TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS verification_challenges (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_verification_challenges_lookup ON verification_challenges(phone,purpose,expires_at);

  CREATE TABLE IF NOT EXISTS customer_profile (
    user_id TEXT PRIMARY KEY, shop_name TEXT, shop_address TEXT, business_type TEXT,
    customer_level TEXT, receive_preference TEXT, brand_preference TEXT,
    internal_remark TEXT, birthday TEXT, anniversary TEXT, profile_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS addresses (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient_name TEXT NOT NULL, phone TEXT NOT NULL,
    province TEXT NOT NULL, city TEXT NOT NULL, district TEXT NOT NULL, detail TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id,is_default,created_at);

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, category_key TEXT,
    subcategory_key TEXT, brand TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'inactive',
    warehouse_product_id TEXT, warehouse_revision INTEGER, warehouse_payload_hash TEXT,
    warehouse_sale_status TEXT, warehouse_media_revision INTEGER, first_activated_at TEXT,
    archived_at TEXT, permanently_hidden_at TEXT, status_before_archive TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_products_status ON products(status,archived_at,permanently_hidden_at);
  CREATE TABLE IF NOT EXISTS product_skus (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sku_code TEXT NOT NULL,
    spec_name TEXT NOT NULL, base_price REAL NOT NULL DEFAULT 0, warehouse_base_price REAL,
    sale_price_override REAL, campaign_price REAL, campaign_starts_at TEXT, campaign_ends_at TEXT,
    campaign_paused INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, warehouse_variant_id TEXT,
    archived_at TEXT, archived_by_product INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id,sku_code)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_product_skus_code ON product_skus(sku_code);
  CREATE TABLE IF NOT EXISTS tier_prices (
    id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, min_qty INTEGER NOT NULL, max_qty INTEGER,
    unit_price REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sku_id,min_qty)
  );
  CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS product_recommendations (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, recommended_product_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id,recommended_product_id)
  );
  CREATE TABLE IF NOT EXISTS product_file_cleanup (
    storage_key TEXT PRIMARY KEY, product_id TEXT, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, sku_id TEXT NOT NULL, quantity INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id,sku_id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, buyer_user_id TEXT NOT NULL,
    status TEXT NOT NULL, subtotal REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0,
    discount_rate REAL NOT NULL DEFAULT 0, manual_reduction REAL NOT NULL DEFAULT 0,
    points_used INTEGER NOT NULL DEFAULT 0, points_discount REAL NOT NULL DEFAULT 0,
    shipping_fee REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL DEFAULT 0,
    quote_version INTEGER NOT NULL DEFAULT 0, confirmed_quote_version INTEGER NOT NULL DEFAULT 0,
    recipient_snapshot TEXT NOT NULL, customer_remark TEXT, idempotency_key TEXT,
    closed_at TEXT, deleted_at TEXT, deleted_by TEXT, deleted_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(buyer_user_id,idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sku_id TEXT NOT NULL, sku_code TEXT NOT NULL,
    product_name TEXT NOT NULL, spec_name TEXT, quantity INTEGER NOT NULL, list_price REAL NOT NULL,
    unit_price REAL NOT NULL, line_total REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_quotes (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, version INTEGER NOT NULL, subtotal REAL NOT NULL,
    discount_rate REAL NOT NULL DEFAULT 0, manual_reduction REAL NOT NULL DEFAULT 0,
    points_used INTEGER NOT NULL DEFAULT 0, points_discount REAL NOT NULL DEFAULT 0,
    shipping_fee REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL, reason TEXT, operator_id TEXT,
    confirmed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(order_id,version)
  );
  CREATE TABLE IF NOT EXISTS order_quote_items (
    id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, order_item_id TEXT NOT NULL,
    old_unit_price REAL NOT NULL, new_unit_price REAL NOT NULL, quantity INTEGER NOT NULL, line_total REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_price_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, operator_id TEXT NOT NULL,
    old_total REAL NOT NULL, new_total REAL NOT NULL, adjust_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customer_sku_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, order_id TEXT NOT NULL,
    sku TEXT NOT NULL, product_name TEXT, quantity INTEGER NOT NULL, unit_price REAL NOT NULL,
    operator_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id,sku)
  );

  CREATE TABLE IF NOT EXISTS im_conversation (
    user_id TEXT NOT NULL, target_id TEXT NOT NULL, last_msg TEXT NOT NULL DEFAULT '',
    unread_count INTEGER NOT NULL DEFAULT 0, owner_clear_before_id INTEGER NOT NULL DEFAULT 0,
    owner_hidden_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,target_id)
  );
  CREATE TABLE IF NOT EXISTS im_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id TEXT NOT NULL, to_user_id TEXT NOT NULL,
    order_id TEXT, msg_type TEXT NOT NULL DEFAULT 'text', content TEXT NOT NULL,
    payload_json TEXT, quote_version INTEGER, event_key TEXT UNIQUE, is_read INTEGER NOT NULL DEFAULT 0,
    read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_im_message_pair ON im_message(from_user_id,to_user_id,id);
  CREATE TABLE IF NOT EXISTS im_message_batch (
    batch_id TEXT NOT NULL, buyer_user_id TEXT NOT NULL, owner_user_id TEXT,
    payload_hash TEXT, message_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(batch_id,buyer_user_id)
  );
  CREATE TABLE IF NOT EXISTS integration_nonces (
    nonce TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS warehouse_media_sync (
    id TEXT UNIQUE, product_id TEXT PRIMARY KEY, warehouse_product_id TEXT NOT NULL, warehouse_revision INTEGER NOT NULL,
    media_revision INTEGER NOT NULL, asset_ids_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory_compensations (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, completed_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS loyalty_accounts (
    user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, balance_points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS loyalty_ledger (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, points INTEGER NOT NULL, balance_after INTEGER NOT NULL,
    kind TEXT NOT NULL, order_id TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS order_loyalty (
    order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, points_used INTEGER NOT NULL DEFAULT 0,
    points_discount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customer_notices (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, document_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','offline')),
    idempotency_key TEXT UNIQUE, published_at TEXT, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_customer_notices_public ON customer_notices(status,published_at,updated_at);
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO schema_migrations(version) VALUES('20260824-commerce-enhancements-v1');
`);

function ensureColumn(table: string, column: string, definition: string) {
  const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(item => item.name));
  if (!names.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users", "updated_at", "TEXT");
ensureColumn("customer_profile", "updated_at", "TEXT");
db.prepare("UPDATE users SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP) WHERE updated_at IS NULL").run();
db.prepare("UPDATE customer_profile SET updated_at=COALESCE(updated_at,created_at,CURRENT_TIMESTAMP) WHERE updated_at IS NULL").run();
ensureColumn("product_skus", "campaign_price", "REAL");
ensureColumn("product_skus", "campaign_starts_at", "TEXT");
ensureColumn("product_skus", "campaign_ends_at", "TEXT");
ensureColumn("product_skus", "campaign_paused", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("product_images", "warehouse_asset_id", "TEXT");
ensureColumn("product_file_cleanup", "product_id", "TEXT");
ensureColumn("loyalty_accounts", "balance_points", "INTEGER NOT NULL DEFAULT 0");
// Keep loyalty code compatible with databases created before the ledger
// schema was expanded.  Every addition is guarded so cold starts are safe.
ensureColumn("loyalty_ledger", "event_type", "TEXT NOT NULL DEFAULT 'earn'");
ensureColumn("loyalty_ledger", "points_delta", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("loyalty_ledger", "amount_fen", "INTEGER");
ensureColumn("loyalty_ledger", "event_key", "TEXT");
ensureColumn("order_loyalty", "gross_amount_fen", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "reserved_points", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "redemption_fen", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "cash_payable_fen", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "redeemed_points", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "earned_points", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_loyalty", "state", "TEXT NOT NULL DEFAULT 'reserved'");
ensureColumn("order_loyalty", "updated_at", "TEXT");
ensureColumn("warehouse_media_sync", "warehouse_product_id", "TEXT NOT NULL DEFAULT ''");
ensureColumn("warehouse_media_sync", "warehouse_revision", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("warehouse_media_sync", "asset_ids_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("warehouse_media_sync", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("warehouse_media_sync", "next_attempt_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
ensureColumn("warehouse_media_sync", "claim_token", "TEXT");
ensureColumn("warehouse_media_sync", "lease_expires_at", "TEXT");
ensureColumn("warehouse_media_sync", "completed_at", "TEXT");
// Order lifecycle v2 is additive and guarded for legacy databases.
for (const [column, definition] of [["order_version", "INTEGER NOT NULL DEFAULT 1"], ["merchant_confirmed_version", "INTEGER NOT NULL DEFAULT 0"], ["buyer_confirmed_version", "INTEGER NOT NULL DEFAULT 0"], ["confirmation_status", "TEXT NOT NULL DEFAULT 'merchant_review'"], ["payment_status", "TEXT NOT NULL DEFAULT 'unpaid'"], ["payment_method", "TEXT"], ["fulfillment_status", "TEXT NOT NULL DEFAULT 'unfulfilled'"], ["fulfillment_method", "TEXT NOT NULL DEFAULT 'express'"], ["customer_hidden_at", "TEXT"], ["migration_source", "TEXT"]] as const) ensureColumn("orders", column, definition);
for (const [column, definition] of [["shipping_carrier", "TEXT"], ["tracking_number", "TEXT"], ["tracking_url", "TEXT"], ["paid_at", "TEXT"], ["payment_confirmed_by", "TEXT"], ["shipped_at", "TEXT"]] as const) ensureColumn("orders", column, definition);
db.exec("CREATE TABLE IF NOT EXISTS order_revisions (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT NOT NULL, actor_user_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(order_id,version))");
db.exec("CREATE INDEX IF NOT EXISTS idx_order_revisions_order ON order_revisions(order_id,version)");
db.prepare("UPDATE orders SET migration_source=COALESCE(migration_source,'legacy-order-schema') WHERE migration_source IS NULL").run();
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_media_product ON warehouse_media_sync(product_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_warehouse_media_due ON warehouse_media_sync(status,next_attempt_at,lease_expires_at)");
db.exec("COMMIT");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch { /* Preserve the bootstrap error. */ }
  throw error;
}

export function getDb() { return db; }
export default db;
