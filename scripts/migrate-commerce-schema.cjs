const Database = require("better-sqlite3");
const path = require("node:path");
const raw = process.env.DATABASE_URL || process.argv[2] || "file:data/app.db";
const file = raw.replace(/^file:/, "");
const db = new Database(path.resolve(file), { timeout: 5000 });
db.pragma("journal_mode = WAL");
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (name) => hasTable(name) ? new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((x) => x.name)) : new Set();
const add = (table, name, sql) => { if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`); };
const migrate = db.transaction(() => {
  if (hasTable("product_skus")) {
    add("product_skus", "campaign_price", "REAL");
    add("product_skus", "campaign_starts_at", "TEXT");
    add("product_skus", "campaign_ends_at", "TEXT");
    add("product_skus", "campaign_paused", "INTEGER NOT NULL DEFAULT 0");
  }
  if (hasTable("product_images")) add("product_images", "warehouse_asset_id", "TEXT");
  if (hasTable("product_file_cleanup")) add("product_file_cleanup", "product_id", "TEXT");
  if (hasTable("loyalty_accounts")) add("loyalty_accounts", "balance_points", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
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
});
try { migrate(); console.log("migration ok", db.pragma("quick_check", { simple: true })); }
finally { db.close(); }
