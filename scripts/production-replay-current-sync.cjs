const Database = require("better-sqlite3");

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");
const db = new Database(databasePath);
if (db.pragma("quick_check", { simple: true }) !== "ok") {
  throw new Error("SQLite quick_check failed");
}

const now = new Date().toISOString();
const result = db.prepare(`UPDATE order_sync_outbox
  SET status='pending', attempt_count=0, last_error=NULL, next_attempt_at=?, delivered_at=NULL, updated_at=?
  WHERE status='dead' AND EXISTS (
    SELECT 1 FROM products p WHERE p.id=order_sync_outbox.product_id AND p.revision=order_sync_outbox.revision
  )`).run(now, now);
console.log(JSON.stringify({ replayedCurrentVersions: result.changes }));
db.close();
