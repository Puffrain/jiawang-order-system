import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { getWechatPayConfigStatus } from "@/lib/wechat-pay-config";
import { buildJsapiPayParams, createJsapiPrepay, createOutTradeNo, getWechatPayConfig } from "@/lib/wechat-pay";
import { moneyToFen } from "@/lib/loyalty";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const orderId = (await params).id;
  const status = getWechatPayConfigStatus();
  if (!status.ready) return NextResponse.json({ error: "微信支付尚未配置", code: "NOT_CONFIGURED", missing: status.missing }, { status: 503 });
  const order = db.prepare("SELECT id,order_no orderNo,status,payment_status paymentStatus,confirmation_status confirmationStatus,order_version orderVersion,total_amount totalAmount,buyer_user_id buyerUserId FROM orders WHERE id=? AND deleted_at IS NULL").get(orderId) as { id:string;orderNo:string;status:string;paymentStatus:string;confirmationStatus:string;orderVersion:number;totalAmount:number;buyerUserId:string } | undefined;
  if (!order || order.buyerUserId !== auth.session!.userId) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.status !== "pending_payment" || order.paymentStatus !== "unpaid" || order.confirmationStatus !== "confirmed") return NextResponse.json({ error: "当前订单不能发起支付" }, { status: 409 });
  const buyer = db.prepare("SELECT wechat_openid wechatOpenid FROM users WHERE id=? AND status='active'").get(auth.session!.userId) as { wechatOpenid:string|null } | undefined;
  if (!buyer?.wechatOpenid) return NextResponse.json({ error: "请先使用微信登录" }, { status: 409 });
  const amountFen = moneyToFen(order.totalAmount);
  const existing = db.prepare("SELECT id,out_trade_no outTradeNo,prepay_id prepayId,amount_fen amountFen,status,order_version orderVersion FROM wechat_payment_intents WHERE order_id=? AND order_version=?").get(orderId, order.orderVersion) as { id:string;outTradeNo:string;prepayId:string|null;amountFen:number;status:string;orderVersion:number } | undefined;
  if (existing?.prepayId && existing.amountFen === amountFen && ["created", "pending"].includes(existing.status)) {
    const config = getWechatPayConfig();
    return NextResponse.json({ ok:true, outTradeNo:existing.outTradeNo, orderVersion:existing.orderVersion, amountFen, ...buildJsapiPayParams(config, existing.prepayId) });
  }
  const intentId = existing?.id || randomUUID();
  const outTradeNo = existing?.outTradeNo || createOutTradeNo(order.orderNo);
  db.prepare("INSERT INTO wechat_payment_intents(id,order_id,order_version,out_trade_no,amount_fen,status,payer_openid,expires_at) VALUES(?,?,?,?,?,'created',?,datetime('now','+30 minutes')) ON CONFLICT(order_id,order_version) DO UPDATE SET amount_fen=excluded.amount_fen,payer_openid=excluded.payer_openid,status='created',updated_at=CURRENT_TIMESTAMP").run(intentId, orderId, order.orderVersion, outTradeNo, amountFen, buyer.wechatOpenid);
  try {
    const result = await createJsapiPrepay({ outTradeNo, description: "佳旺订单 " + order.orderNo, totalFen: amountFen, openid: buyer.wechatOpenid, orderVersion: order.orderVersion });
    db.prepare("UPDATE wechat_payment_intents SET prepay_id=?,status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND amount_fen=?").run(result.prepay_id, intentId, amountFen);
    return NextResponse.json({ ok:true, outTradeNo, orderVersion:order.orderVersion, amountFen, ...buildJsapiPayParams(result.config, result.prepay_id) });
  } catch (error) {
    db.prepare("UPDATE wechat_payment_intents SET status='failed',failure_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(error instanceof Error ? error.message.slice(0,120) : "WECHAT_PAY_FAILED", intentId);
    return NextResponse.json({ error: "微信支付下单失败，请稍后重试" }, { status: 502 });
  }
}
