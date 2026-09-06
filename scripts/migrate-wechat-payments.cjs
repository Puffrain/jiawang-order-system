const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const file = (process.env.DATABASE_URL || process.argv[2] || 'file:data/app.db').replace(/^file:/, '');
const db = new Database(path.resolve(file), { timeout: 30000 });
const versions = ['002_wechat_payments', '003_wechat_refund_single_order'];

function statementsForMigration(version) {
  return fs.readFileSync(path.join(__dirname, '..', 'migrations', version + '.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((sql) => sql.trim())
    .filter(Boolean);
}

try {
  db.pragma('busy_timeout = 30000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const version of versions) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) continue;
    if (version === '003_wechat_refund_single_order') {
      const duplicate = db.prepare("SELECT order_id FROM wechat_refunds GROUP BY order_id HAVING COUNT(*) > 1 LIMIT 1").get();
      if (duplicate) throw new Error(`WECHAT_REFUND_MIGRATION_DUPLICATE_ORDER:${duplicate.order_id}`);
    }
    db.transaction(() => {
      for (const sql of statementsForMigration(version)) {
        try { db.exec(sql); }
        catch (error) {
          if (!/^ALTER TABLE/i.test(sql) || !/duplicate column name/i.test(String(error))) throw error;
        }
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)').run(version);
    })();
  }
  console.log('wechat payments migration ok', db.pragma('quick_check', { simple: true }));
} finally { db.close(); }
