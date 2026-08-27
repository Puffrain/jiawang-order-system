import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

type SqliteDb = Database.Database;

export const POINT_VALUE_FEN = 10;
export const EARN_AMOUNT_FEN = 100;

export function moneyToFen(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("订单金额无效");
  const fen = Math.round(amount * 100);
  if (!Number.isSafeInteger(fen)) throw new Error("订单金额超出范围");
  return fen;
}

export function pointsToFen(points: number): number {
  if (!Number.isSafeInteger(points) || points < 0) throw new Error("积分必须是非负整数");
  return points * POINT_VALUE_FEN;
}

export function maxRedeemablePoints(amountFen: number): number {
  if (!Number.isSafeInteger(amountFen) || amountFen < 0) throw new Error("订单金额无效");
  return Math.floor(amountFen / POINT_VALUE_FEN);
}

export function earnedPoints(cashPayableFen: number): number {
  if (!Number.isSafeInteger(cashPayableFen) || cashPayableFen < 0) throw new Error("实付金额无效");
  return Math.floor(cashPayableFen / EARN_AMOUNT_FEN);
}

function ensureAccount(db: SqliteDb, userId: string): void {
  db.prepare("INSERT OR IGNORE INTO loyalty_accounts(user_id,balance_points) VALUES(?,0)").run(userId);
}

function balance(db: SqliteDb, userId: string): number {
  ensureAccount(db, userId);
  return Number((db.prepare("SELECT balance_points balance FROM loyalty_accounts WHERE user_id=?").get(userId) as { balance: number }).balance);
}

function ledger(db: SqliteDb, input: { userId: string; orderId: string; eventType: "reserve" | "release" | "commit" | "earn" | "refund_restore"; delta: number; balanceAfter: number; amountFen?: number; eventKey: string }): void {
  db.prepare("INSERT INTO loyalty_ledger(id,user_id,order_id,event_type,points_delta,balance_after,amount_fen,event_key) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), input.userId, input.orderId, input.eventType, input.delta, input.balanceAfter, input.amountFen ?? null, input.eventKey);
}

export function reserveOrderPoints(db: SqliteDb, input: { orderId: string; userId: string; grossAmountFen: number; pointsToUse: number }): { points: number; discountFen: number; cashPayableFen: number } {
  const requested = input.pointsToUse;
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error("使用积分必须是非负整数");
  const points = Math.min(requested, maxRedeemablePoints(input.grossAmountFen));
  ensureAccount(db, input.userId);
  if (points > 0) {
    const updated = db.prepare("UPDATE loyalty_accounts SET balance_points=balance_points-?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND balance_points>=?").run(points, input.userId, points);
    if (updated.changes !== 1) throw new Error("可用积分不足，请刷新后重试");
    ledger(db, { userId: input.userId, orderId: input.orderId, eventType: "reserve", delta: -points, balanceAfter: balance(db, input.userId), amountFen: pointsToFen(points), eventKey: `loyalty:reserve:${input.orderId}` });
  }
  const discountFen = pointsToFen(points);
  const cashPayableFen = input.grossAmountFen - discountFen;
  db.prepare("INSERT INTO order_loyalty(order_id,user_id,gross_amount_fen,reserved_points,redemption_fen,cash_payable_fen) VALUES(?,?,?,?,?,?)")
    .run(input.orderId, input.userId, input.grossAmountFen, points, discountFen, cashPayableFen);
  return { points, discountFen, cashPayableFen };
}

export function reconcileOrderPoints(db: SqliteDb, orderId: string, grossAmountFen: number, revision: string | number): { points: number; discountFen: number; cashPayableFen: number } {
  const row = db.prepare("SELECT user_id userId,reserved_points reservedPoints,redeemed_points redeemedPoints,state FROM order_loyalty WHERE order_id=?").get(orderId) as { userId: string; reservedPoints: number; redeemedPoints: number; state: string } | undefined;
  if (!row) return { points: 0, discountFen: 0, cashPayableFen: grossAmountFen };
  if (row.state !== "reserved") throw new Error("订单积分已结算，不能再次改价");
  const points = Math.min(row.reservedPoints, maxRedeemablePoints(grossAmountFen));
  const released = row.reservedPoints - points;
  if (released > 0) {
    db.prepare("UPDATE loyalty_accounts SET balance_points=balance_points+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(released, row.userId);
    ledger(db, { userId: row.userId, orderId, eventType: "release", delta: released, balanceAfter: balance(db, row.userId), amountFen: pointsToFen(released), eventKey: `loyalty:release:${orderId}:quote:${revision}` });
  }
  const discountFen = pointsToFen(points);
  const cashPayableFen = grossAmountFen - discountFen;
  db.prepare("UPDATE order_loyalty SET gross_amount_fen=?,reserved_points=?,redemption_fen=?,cash_payable_fen=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=?")
    .run(grossAmountFen, points, discountFen, cashPayableFen, orderId);
  return { points, discountFen, cashPayableFen };
}

export function commitOrderPoints(db: SqliteDb, orderId: string): void {
  const row = db.prepare("SELECT user_id userId,reserved_points reservedPoints,state FROM order_loyalty WHERE order_id=?").get(orderId) as { userId: string; reservedPoints: number; state: string } | undefined;
  if (!row || row.state === "committed" || row.state === "completed") return;
  if (row.state !== "reserved") throw new Error("订单积分预占状态无效");
  db.prepare("UPDATE order_loyalty SET redeemed_points=reserved_points,reserved_points=0,state='committed',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);
  ledger(db, { userId: row.userId, orderId, eventType: "commit", delta: 0, balanceAfter: balance(db, row.userId), amountFen: pointsToFen(row.reservedPoints), eventKey: `loyalty:commit:${orderId}` });
}

export function releaseOrderPoints(db: SqliteDb, orderId: string): void {
  const row = db.prepare("SELECT user_id userId,reserved_points reservedPoints,redeemed_points redeemedPoints,state FROM order_loyalty WHERE order_id=?").get(orderId) as { userId: string; reservedPoints: number; redeemedPoints: number; state: string } | undefined;
  if (!row || row.state === "released" || row.state === "completed") return;
  const points = row.state === "reserved" ? row.reservedPoints : row.redeemedPoints;
  if (points > 0) {
    db.prepare("UPDATE loyalty_accounts SET balance_points=balance_points+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(points, row.userId);
    ledger(db, { userId: row.userId, orderId, eventType: row.state === "reserved" ? "release" : "refund_restore", delta: points, balanceAfter: balance(db, row.userId), amountFen: pointsToFen(points), eventKey: `loyalty:cancel:${orderId}` });
  }
  db.prepare("UPDATE order_loyalty SET reserved_points=0,redeemed_points=0,state='released',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(orderId);
}

export function completeOrderPoints(db: SqliteDb, orderId: string): number {
  const row = db.prepare("SELECT user_id userId,cash_payable_fen cashPayableFen,state,earned_points earnedPoints FROM order_loyalty WHERE order_id=?").get(orderId) as { userId: string; cashPayableFen: number; state: string; earnedPoints: number } | undefined;
  if (!row) return 0;
  if (row.state === "completed") return row.earnedPoints;
  if (row.state !== "committed") throw new Error("订单积分尚未完成抵扣结算");
  const points = earnedPoints(row.cashPayableFen);
  if (points > 0) {
    db.prepare("UPDATE loyalty_accounts SET balance_points=balance_points+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run(points, row.userId);
    ledger(db, { userId: row.userId, orderId, eventType: "earn", delta: points, balanceAfter: balance(db, row.userId), amountFen: row.cashPayableFen, eventKey: `loyalty:earn:${orderId}` });
  }
  db.prepare("UPDATE order_loyalty SET earned_points=?,state='completed',updated_at=CURRENT_TIMESTAMP WHERE order_id=?").run(points, orderId);
  return points;
}

export function getLoyaltySummary(db: SqliteDb, userId: string, limit = 50) {
  ensureAccount(db, userId);
  const account = db.prepare("SELECT balance_points balancePoints,updated_at updatedAt FROM loyalty_accounts WHERE user_id=?").get(userId) as { balancePoints: number; updatedAt: string };
  const totals = db.prepare("SELECT COALESCE(SUM(CASE WHEN event_type='earn' THEN points_delta ELSE 0 END),0) earnedPoints FROM loyalty_ledger WHERE user_id=?").get(userId) as { earnedPoints: number };
  const redeemed = db.prepare("SELECT COALESCE(SUM(redeemed_points),0) redeemedPoints,COALESCE(SUM(CASE WHEN state IN ('committed','completed') THEN redemption_fen ELSE 0 END),0) redeemedFen FROM order_loyalty WHERE user_id=? AND state IN ('committed','completed')").get(userId) as { redeemedPoints: number; redeemedFen: number };
  const entries = db.prepare("SELECT l.id,l.order_id orderId,l.event_type eventType,l.points_delta pointsDelta,l.balance_after balanceAfter,l.amount_fen amountFen,l.created_at createdAt,o.order_no orderNo FROM loyalty_ledger l LEFT JOIN orders o ON o.id=l.order_id WHERE l.user_id=? AND l.points_delta<>0 ORDER BY l.created_at DESC,l.id DESC LIMIT ?").all(userId, Math.max(1, Math.min(limit, 100)));
  return { ...account, earnedPoints: Number(totals.earnedPoints), redeemedPoints: Number(redeemed.redeemedPoints), redeemedFen: Number(redeemed.redeemedFen), pointValueFen: POINT_VALUE_FEN, earnAmountFen: EARN_AMOUNT_FEN, entries };
}
