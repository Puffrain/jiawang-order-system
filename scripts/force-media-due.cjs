const Database = require("better-sqlite3");
const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");
const db = new Database(databasePath);
const result = db.prepare("UPDATE warehouse_media_sync SET next_attempt_at=?,updated_at=CURRENT_TIMESTAMP WHERE status='pending'").run(new Date(0).toISOString());
console.log(JSON.stringify({ forcedDue: result.changes }));
db.close();
