import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-payment-state-"));
const file = path.join(dir, "app.db");
process.env.DATABASE_URL = file;

try {
  const { default: db } = await import("../../lib/db");
  const { applyWechatPaymentSuccess, applyWechatRefundSuccess } = await import("../../lib/payment-state");
  db.prepare("INSERT INTO users(id,role,status,wechat_openid) VALUES('buyer','buyer','active','openid-1')").run();
  db.prepare("INSERT INTO orders(id,order_no,buyer_user_id,status,payment_status,order_version,total_amount,recipient_snapshot) VALUES('order-1','O-1','buyer','pending_payment','unpaid',1,12.34,'{}')").run();
  db.prepare("INSERT INTO wechat_payment_intents(id,order_id,order_version,out_trade_no,amount_fen,status,payer_openid) VALUES('intent-1','order-1',1,'trade-1',1234,'created','openid-1')").run();

  assert.deepEqual(applyWechatPaymentSuccess({ outTradeNo: "trade-1", transactionId: "transaction-1", payerOpenid: "openid-1", totalFen: 1234 }), { orderId: "order-1", alreadyProcessed: false });
  assert.deepEqual(applyWechatPaymentSuccess({ outTradeNo: "trade-1", transactionId: "transaction-1", payerOpenid: "openid-1", totalFen: 1234 }), { orderId: "order-1", alreadyProcessed: true });
  assert.throws(() => applyWechatPaymentSuccess({ outTradeNo: "trade-1", transactionId: "transaction-other", payerOpenid: "openid-1", totalFen: 1234 }), /WECHAT_PAYMENT_MISMATCH/);

  db.prepare("INSERT INTO wechat_refunds(id,order_id,payment_intent_id,out_refund_no,refund_id,amount_fen,total_fen,status,requested_by) VALUES('refund-1','order-1','intent-1','refund-out-1','refund-1',1234,1234,'pending','owner')").run();
  assert.deepEqual(applyWechatRefundSuccess({ outRefundNo: "refund-out-1", refundId: "refund-1" }), { orderId: "order-1", alreadyProcessed: false });
  assert.deepEqual(applyWechatRefundSuccess({ outRefundNo: "refund-out-1", refundId: "refund-1" }), { orderId: "order-1", alreadyProcessed: true });
  assert.throws(() => applyWechatRefundSuccess({ outRefundNo: "refund-out-1", refundId: "refund-other" }), /WECHAT_REFUND_MISMATCH/);
  const finalOrder = db.prepare("SELECT payment_status paymentStatus,wechat_transaction_id transactionId FROM orders WHERE id='order-1'").get() as { paymentStatus: string; transactionId: string };
  assert.equal(finalOrder.paymentStatus, "refunded");
  db.close();
  console.log("wechat payment state runtime PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
