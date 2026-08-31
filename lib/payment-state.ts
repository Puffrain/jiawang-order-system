import db from "@/lib/db";
import { commitOrderPoints, releaseOrderPoints } from "@/lib/loyalty";

export function applyWechatPaymentSuccess(input: { outTradeNo: string; transactionId: string; payerOpenid: string; totalFen: number; paidAt?: string }) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT i.id intentId,i.order_id orderId,i.order_version orderVersion,i.amount_fen amountFen,i.payer_openid payerOpenid,i.status intentStatus,o.buyer_user_id buyerUserId,o.status,o.payment_status paymentStatus,o.order_version currentOrderVersion,o.total_amount totalAmount,u.wechat_openid wechatOpenid FROM wechat_payment_intents i JOIN orders o ON o.id=i.order_id JOIN users u ON u.id=o.buyer_user_id WHERE i.out_trade_no=?`).get(input.outTradeNo) as { intentId:string;orderId:string;orderVersion:number;amountFen:number;payerOpenid:string;intentStatus:string;buyerUserId:string;status:string;paymentStatus:string;currentOrderVersion:number;totalAmount:number;wechatOpenid:string|null }|undefined;
    if (!row) throw new Error("WECHAT_ORDER_NOT_FOUND");
    if (row.amountFen !== input.totalFen || Math.round(row.totalAmount * 100) !== input.totalFen || row.payerOpenid !== input.payerOpenid || row.wechatOpenid !== input.payerOpenid || row.orderVersion !== row.currentOrderVersion) throw new Error("WECHAT_PAYMENT_MISMATCH");
    if (row.paymentStatus === "paid" && row.intentStatus === "paid") return { orderId: row.orderId, alreadyProcessed: true };
    if (row.paymentStatus === "refunded" || !["pending_payment", "pending_shipment"].includes(row.status)) throw new Error("WECHAT_ORDER_STATE_INVALID");
    const paidAt = input.paidAt || new Date().toISOString();
    db.prepare("UPDATE wechat_payment_intents SET status='paid',transaction_id=?,paid_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (transaction_id IS NULL OR transaction_id=?)").run(input.transactionId, paidAt, row.intentId, input.transactionId);
    db.prepare("UPDATE orders SET payment_status='paid',payment_method='wechat',paid_at=?,wechat_transaction_id=?,status=CASE WHEN status='pending_payment' THEN 'pending_shipment' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status<>'refunded'").run(paidAt, input.transactionId, row.orderId);
    commitOrderPoints(db, row.orderId);
    return { orderId: row.orderId, alreadyProcessed: false };
  })();
}

export function applyWechatRefundSuccess(input: { outRefundNo: string; refundId: string; successAt?: string }) {
  return db.transaction(() => {
    const row = db.prepare("SELECT r.id,r.order_id orderId,r.amount_fen amountFen,r.total_fen totalFen,r.status,o.payment_status paymentStatus,o.fulfillment_status fulfillmentStatus FROM wechat_refunds r JOIN orders o ON o.id=r.order_id WHERE r.out_refund_no=?").get(input.outRefundNo) as {id:string;orderId:string;amountFen:number;totalFen:number;status:string;paymentStatus:string;fulfillmentStatus:string}|undefined;
    if (!row) throw new Error("WECHAT_REFUND_NOT_FOUND");
    if (row.status === "succeeded" && row.paymentStatus === "refunded") return { orderId: row.orderId, alreadyProcessed: true };
    if (row.amountFen !== row.totalFen || row.paymentStatus !== "paid") throw new Error("WECHAT_REFUND_STATE_INVALID");
    const at = input.successAt || new Date().toISOString();
    db.prepare("UPDATE wechat_refunds SET status='succeeded',refund_id=?,success_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(input.refundId, at, row.id);
    db.prepare("UPDATE orders SET payment_status='refunded',refunded_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payment_status='paid'").run(at, row.orderId);
    releaseOrderPoints(db, row.orderId);
    return { orderId: row.orderId, alreadyProcessed: false };
  })();
}
