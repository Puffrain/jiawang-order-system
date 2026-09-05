import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { getWechatPayConfigStatus } from "@/lib/wechat-pay-config";
import { createDomesticRefund } from "@/lib/wechat-pay";
import { moneyToFen } from "@/lib/loyalty";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  if (!getWechatPayConfigStatus().ready) return NextResponse.json({ error: "微信支付尚未配置", code: "NOT_CONFIGURED" }, { status: 503 });

  const id = (await params).id;
  const body = await request.json().catch(() => ({}));
  const order = db.prepare("SELECT id,total_amount totalAmount,payment_status paymentStatus,wechat_transaction_id transactionId,fulfillment_status fulfillmentStatus FROM orders WHERE id=? AND deleted_at IS NULL").get(id) as { id: string; totalAmount: number; paymentStatus: string; transactionId: string | null; fulfillmentStatus: string } | undefined;
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.paymentStatus !== "paid" || !order.transactionId) return NextResponse.json({ error: "订单尚未完成微信支付" }, { status: 409 });
  if (!["unfulfilled", "assigned", "failed"].includes(order.fulfillmentStatus)) return NextResponse.json({ error: "订单已发货、配送中或已送达，请先完成售后和物流处理后再退款" }, { status: 409 });

  const existing = db.prepare("SELECT out_refund_no outRefundNo,status FROM wechat_refunds WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(id) as { outRefundNo: string; status: string } | undefined;
  if (existing) return NextResponse.json({ ok: true, outRefundNo: existing.outRefundNo, status: existing.status, replayed: true });

  const totalFen = moneyToFen(order.totalAmount);
  const outRefundNo = "RF" + randomUUID().replaceAll("-", "").slice(0, 28);
  const reason = String(body.reason || "").trim().slice(0, 80) || "订单退款";
  const paymentIntent = db.prepare("SELECT id FROM wechat_payment_intents WHERE order_id=? AND status='paid' ORDER BY created_at DESC LIMIT 1").get(id) as { id: string } | undefined;
  if (!paymentIntent) return NextResponse.json({ error: "支付记录不存在" }, { status: 409 });

  try {
    db.prepare("INSERT INTO wechat_refunds(id,order_id,payment_intent_id,out_refund_no,amount_fen,total_fen,reason,status,requested_by) VALUES(?,?,?,?,?,?,?,'created',?)")
      .run(randomUUID(), id, paymentIntent.id, outRefundNo, totalFen, totalFen, reason, auth.session!.userId);
  } catch (error) {
    if (!/UNIQUE constraint failed: wechat_refunds\.order_id/.test(String(error))) throw error;
    const concurrent = db.prepare("SELECT out_refund_no outRefundNo,status FROM wechat_refunds WHERE order_id=?").get(id) as { outRefundNo: string; status: string } | undefined;
    if (!concurrent) throw error;
    return NextResponse.json({ ok: true, outRefundNo: concurrent.outRefundNo, status: concurrent.status, replayed: true });
  }
  try {
    const result = await createDomesticRefund({ outRefundNo, transactionId: order.transactionId, refundFen: totalFen, totalFen, reason });
    db.prepare("UPDATE wechat_refunds SET status='pending',refund_id=?,updated_at=CURRENT_TIMESTAMP WHERE out_refund_no=?").run((result as { refund_id?: string }).refund_id || null, outRefundNo);
    return NextResponse.json({ ok: true, outRefundNo, status: "pending" }, { status: 202 });
  } catch {
    db.prepare("UPDATE wechat_refunds SET status='failed',failure_code='WECHAT_REFUND_FAILED',updated_at=CURRENT_TIMESTAMP WHERE out_refund_no=?").run(outRefundNo);
    return NextResponse.json({ error: "微信退款申请失败，请稍后重试" }, { status: 502 });
  }
}
