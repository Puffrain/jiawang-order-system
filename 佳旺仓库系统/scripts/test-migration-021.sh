#!/bin/sh
set -eu

SOURCE_DIR="${SOURCE_DIR:-/source}"
WORK_DIR="${WORK_DIR:-/tmp/warehouse-migration-021}"
DB_PATH="$WORK_DIR/app.db"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
cp -R "$SOURCE_DIR/lib" "$SOURCE_DIR/migrations" "$SOURCE_DIR/scripts" "$WORK_DIR/"
cp "$SOURCE_DIR/package.json" "$SOURCE_DIR/tsconfig.json" "$WORK_DIR/"
ln -s /app/node_modules "$WORK_DIR/node_modules"

cd "$WORK_DIR"
mv migrations/021_order_sync_and_inventory_safety.sql /tmp/021_order_sync_and_inventory_safety.sql
NODE_ENV=test DATABASE_PATH="$DB_PATH" node --import tsx scripts/bootstrap.ts --migrate
node --input-type=module <<'NODE'
import Database from "better-sqlite3";
const db = new Database("/tmp/warehouse-migration-021/app.db");
const now = new Date().toISOString();
db.prepare("INSERT INTO taxonomy_categories(id,code,name,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("migration-category", "migration-category", "Migration", 1, 0, now, now);
db.prepare("INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("migration-user", "migration-user", "not-a-real-password", "admin", 1, now, now);
db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'needs_changes',2,NULL,?,?)").run("migration-published-history", "Historical Product", "migration-category", now, now);
db.prepare("INSERT INTO review_decisions(id,product_id,revision,actor_user_id,decision,created_at) VALUES(?,?,?,?,?,?)").run("migration-review", "migration-published-history", 2, "migration-user", "approve", now);
const insertProduct = db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'needs_changes',2,NULL,?,?)");
for (const id of ["migration-outbox-published", "migration-outbox-draft", "migration-outbox-malformed"]) {
  insertProduct.run(id, id, "migration-category", now, now);
}
const insertOutbox = db.prepare(`INSERT INTO order_sync_outbox
  (id,product_id,revision,event_type,payload_hash,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,'pending',0,?,?,?)`);
insertOutbox.run("migration-event-published", "migration-outbox-published", 1, "legacy", null, JSON.stringify({ status: "published", variants: [{ id: "sku-1" }] }), now, now, now);
insertOutbox.run("migration-event-draft", "migration-outbox-draft", 1, "legacy", null, JSON.stringify({ status: "draft" }), now, now, now);
insertOutbox.run("migration-event-malformed", "migration-outbox-malformed", 1, "legacy", null, "{not-json", now, now, now);
db.close();
NODE
mv /tmp/021_order_sync_and_inventory_safety.sql migrations/021_order_sync_and_inventory_safety.sql
NODE_ENV=test DATABASE_PATH="$DB_PATH" node --import tsx scripts/bootstrap.ts --migrate

node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

const db = new Database('/tmp/warehouse-migration-021/app.db', { readonly: true });
const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
const requireColumn = (table, column) => {
  if (!columns(table).has(column)) throw new Error(`missing ${table}.${column}`);
};

requireColumn('products', 'ever_published_at');
requireColumn('products', 'archived_at');
requireColumn('product_variants', 'deleted_at');
requireColumn('order_sync_outbox', 'media_revision');
requireColumn('order_sync_outbox', 'claim_token');
requireColumn('order_sync_outbox', 'lease_expires_at');

const outboxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_sync_outbox'").get()?.sql ?? '';
if (!outboxSql.includes("'superseded'")) throw new Error('outbox does not accept superseded state');

const quickCheck = db.pragma('quick_check', { simple: true });
if (quickCheck !== 'ok') throw new Error(`quick_check failed: ${quickCheck}`);

const applied = db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE version='021_order_sync_and_inventory_safety.sql'").get().count;
if (applied !== 1) throw new Error(`migration 021 applied ${applied} times`);
const history = db.prepare("SELECT ever_published_at value FROM products WHERE id='migration-published-history'").get()?.value;
if (!history) throw new Error("historical approval did not backfill ever_published_at");
const publishedOutbox = db.prepare("SELECT ever_published_at value FROM products WHERE id='migration-outbox-published'").get()?.value;
if (!publishedOutbox) throw new Error("legacy published outbox did not backfill ever_published_at");
for (const id of ['migration-outbox-draft', 'migration-outbox-malformed']) {
  const value = db.prepare('SELECT ever_published_at value FROM products WHERE id=?').get(id)?.value ?? null;
  if (value !== null) throw new Error(`${id} incorrectly backfilled ever_published_at`);
}

console.log('warehouse migration 020 -> 021: PASS');
db.close();
NODE
