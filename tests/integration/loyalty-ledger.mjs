import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  commitOrderPoints,
  completeOrderPoints,
  earnedPoints,
  maxRedeemablePoints,
  moneyToFen,
  reconcileOrderPoints,
  releaseOrderPoints,
  reserveOrderPoints,
} from "../../lib/loyalty.ts";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, order_no TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS loyalty_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id), balance_points INTEGER NOT NULL DEFAULT 0 CHECK(balance_points >= 0), updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS order_loyalty(order_id TEXT PRIMARY KEY REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),gross_amount_fen INTEGER NOT NULL,reserved_points INTEGER NOT NULL DEFAULT 0,redeemed_points INTEGER NOT NULL DEFAULT 0,redemption_fen INTEGER NOT NULL DEFAULT 0,cash_payable_fen INTEGER NOT NULL,earned_points INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'reserved',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS loyalty_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,points INTEGER NOT NULL,balance_after INTEGER NOT NULL,kind TEXT NOT NULL,order_id TEXT,note TEXT,event_type TEXT NOT NULL DEFAULT 'earn',points_delta INTEGER NOT NULL DEFAULT 0,amount_fen INTEGER,event_key TEXT UNIQUE,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  INSERT OR IGNORE INTO users(id) VALUES('buyer');
  INSERT OR IGNORE INTO loyalty_accounts(user_id,balance_points) VALUES('buyer',500);
`);

const balance = () => Number(db.prepare("SELECT balance_points balance FROM loyalty_accounts WHERE user_id='buyer'").get().balance);
const ledgerCount = () => Number(db.prepare("SELECT COUNT(*) count FROM loyalty_ledger").get().count);
const addOrder = id => db.prepare("INSERT INTO orders(id,order_no) VALUES(?,?)").run(id, `NO-${id}`);

assert.equal(moneyToFen(99.99), 9999);
assert.equal(maxRedeemablePoints(9), 0);
assert.equal(maxRedeemablePoints(10), 1);
assert.equal(earnedPoints(99), 0);
assert.equal(earnedPoints(100), 1);

addOrder("completed");
const reserved = reserveOrderPoints(db, { orderId: "completed", userId: "buyer", grossAmountFen: 9999, pointsToUse: 100 });
assert.deepEqual(reserved, { points: 100, discountFen: 1000, cashPayableFen: 8999 });
assert.equal(balance(), 400);
commitOrderPoints(db, "completed");
assert.equal(completeOrderPoints(db, "completed"), 89);
assert.equal(balance(), 489);
const afterFirstCompletion = ledgerCount();
assert.equal(completeOrderPoints(db, "completed"), 89);
assert.equal(ledgerCount(), afterFirstCompletion, "repeating completion must not add a ledger entry");

addOrder("repriced");
reserveOrderPoints(db, { orderId: "repriced", userId: "buyer", grossAmountFen: 5000, pointsToUse: 300 });
assert.equal(balance(), 189);
assert.deepEqual(reconcileOrderPoints(db, "repriced", 2000, 1), { points: 200, discountFen: 2000, cashPayableFen: 0 });
assert.equal(balance(), 289);
assert.deepEqual(reconcileOrderPoints(db, "repriced", 1000, 2), { points: 100, discountFen: 1000, cashPayableFen: 0 });
assert.equal(balance(), 389);
releaseOrderPoints(db, "repriced");
assert.equal(balance(), 489);
const afterRelease = ledgerCount();
releaseOrderPoints(db, "repriced");
assert.equal(ledgerCount(), afterRelease, "repeating cancellation must not add a ledger entry");

addOrder("paid-cancel");
reserveOrderPoints(db, { orderId: "paid-cancel", userId: "buyer", grossAmountFen: 1000, pointsToUse: 20 });
commitOrderPoints(db, "paid-cancel");
releaseOrderPoints(db, "paid-cancel");
assert.equal(balance(), 489, "closing a paid but uncompleted order restores redeemed points");

addOrder("insufficient");
assert.throws(() => db.transaction(() => reserveOrderPoints(db, { orderId: "insufficient", userId: "buyer", grossAmountFen: 100_000, pointsToUse: 9999 }))(), /积分不足/);
assert.equal(balance(), 489, "a rejected reservation must not change the balance");
console.log("loyalty ledger integration: PASS");
