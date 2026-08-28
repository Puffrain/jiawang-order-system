const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const file = (process.env.DATABASE_URL || process.argv[2] || 'file:data/app.db').replace(/^file:/, '');
const db = new Database(path.resolve(file), { timeout: 5000 });
try {
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const version = '001_order_lifecycle_v2';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) {
    const statements = fs.readFileSync(path.join(__dirname, '..', 'migrations', version + '.sql'), 'utf8')
      .replace(/--[^\n]*/g, '').split(';').map((sql) => sql.trim()).filter(Boolean);
    db.transaction(() => {
      for (const sql of statements) {
        try { db.exec(sql); }
        catch (error) { if (!/^ALTER TABLE/i.test(sql) || !/duplicate column name/i.test(String(error))) throw error; }
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)').run(version);
    })();
  }
  console.log('order lifecycle migration ok', db.pragma('quick_check', { simple: true }));
} finally { db.close(); }
