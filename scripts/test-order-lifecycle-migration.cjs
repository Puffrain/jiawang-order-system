const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-lifecycle-v2-'));
const file = path.join(dir, 'app.db');
try {
  const db = new Database(file);
  db.exec('CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT,quote_version INTEGER,confirmed_quote_version INTEGER); CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT)');
  db.close();
  const run = () => cp.execFileSync(process.execPath, [path.join(__dirname, 'migrate-order-lifecycle.cjs'), file], { encoding: 'utf8' });
  run(); run();
  const check = new Database(file, { readonly: true });
  for (const name of ['order_version','merchant_confirmed_version','buyer_confirmed_version','confirmation_status','payment_status','fulfillment_status','customer_hidden_at']) {
    if (!check.prepare('PRAGMA table_info(orders)').all().some((row) => row.name === name)) throw new Error(name + ' missing');
  }
  if (!check.prepare('SELECT 1 FROM order_revisions LIMIT 1').get() && !check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='order_revisions'").get()) throw new Error('order_revisions missing');
  if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('quick_check failed');
  check.close();
  console.log('order lifecycle migration 2x replay PASS');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
