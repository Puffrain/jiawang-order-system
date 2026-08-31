const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-payments-migration-'));
const file = path.join(dir, 'app.db');
let check;
try {
  const db = new Database(file);
  db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, total_amount REAL NOT NULL DEFAULT 0); CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT)');
  db.close();
  const run = () => cp.execFileSync(process.execPath, [path.join(__dirname, 'migrate-wechat-payments.cjs'), file], { encoding: 'utf8' });
  run(); run();
  check = new Database(file);
  for (const name of ['wechat_transaction_id', 'refunded_at']) {
    if (!check.prepare('PRAGMA table_info(orders)').all().some((row) => row.name === name)) throw new Error(name + ' missing');
  }
  for (const name of ['wechat_payment_intents', 'wechat_refunds', 'wechat_pay_notifications']) {
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error(name + ' missing');
  }
  for (const version of ['002_wechat_payments', '003_wechat_refund_single_order']) if (!check.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) throw new Error('migration marker missing: ' + version);
  check.prepare("INSERT INTO wechat_refunds(id,order_id,payment_intent_id,out_refund_no,amount_fen,total_fen,requested_by) VALUES('refund-1','order-1','intent-1','out-1',1,1,'owner')").run();
  let duplicateBlocked = false;
  try { check.prepare("INSERT INTO wechat_refunds(id,order_id,payment_intent_id,out_refund_no,amount_fen,total_fen,requested_by) VALUES('refund-2','order-1','intent-2','out-2',1,1,'owner')").run(); } catch (error) { duplicateBlocked = /UNIQUE constraint failed/.test(String(error)); }
  if (!duplicateBlocked) throw new Error('second refund for one order was not blocked');
  if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('quick_check failed');
  console.log('wechat payments migration 2x replay PASS');
} finally {
  check?.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
