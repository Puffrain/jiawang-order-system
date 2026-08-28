import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nextVersion } from './order-lifecycle';
type Db = Database.Database;
export function snapshotOrder(db: Db, orderId: string) { return { order: db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), items: db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId) }; }
export function createOrderRevision(db: Db, input: { orderId: string; actorUserId?: string; reason: string; snapshot?: unknown }) {
  const row = db.prepare('SELECT order_version orderVersion FROM orders WHERE id=?').get(input.orderId) as { orderVersion: number } | undefined;
  if (!row) throw new Error('订单不存在');
  const version = nextVersion({ orderVersion: row.orderVersion, status: '', merchantConfirmedVersion: 0, buyerConfirmedVersion: 0, confirmationStatus: 'merchant_review', fulfillmentStatus: 'unfulfilled' });
  db.prepare('INSERT INTO order_revisions(id,order_id,version,snapshot_json,reason,actor_user_id) VALUES(?,?,?,?,?,?)').run(randomUUID(), input.orderId, version, JSON.stringify(input.snapshot ?? snapshotOrder(db, input.orderId)), input.reason, input.actorUserId ?? null);
  db.prepare("UPDATE orders SET order_version=?,merchant_confirmed_version=0,buyer_confirmed_version=0,confirmation_status='merchant_review',confirmed_quote_version=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(version, input.orderId);
  return version;
}
