import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { queryTransaction } from "@/lib/wechat-pay";
import { applyWechatPaymentSuccess } from "@/lib/payment-state";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth=await requireApiRole("buyer"); if(auth.response)return auth.response; const id=(await params).id;
  const order=db.prepare("SELECT id,buyer_user_id buyerUserId,payment_status paymentStatus FROM orders WHERE id=? AND deleted_at IS NULL").get(id) as {id:string;buyerUserId:string;paymentStatus:string}|undefined;
  if(!order||order.buyerUserId!==auth.session!.userId)return NextResponse.json({error:"订单不存在"},{status:404});
  const intent=db.prepare("SELECT out_trade_no outTradeNo,status,transaction_id transactionId,amount_fen amountFen,paid_at paidAt FROM wechat_payment_intents WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(id) as {outTradeNo:string;status:string;transactionId:string|null;amountFen:number;paidAt:string|null}|undefined;
  if(intent&&intent.status!=="paid"&&order.paymentStatus!=="paid")try{const remote=await queryTransaction(intent.outTradeNo) as {trade_state?:string;transaction_id?:string;payer?:{openid?:string};amount?:{total?:number};success_time?:string};if(remote.trade_state==="SUCCESS"&&remote.transaction_id&&remote.payer?.openid&&remote.amount?.total)applyWechatPaymentSuccess({outTradeNo:intent.outTradeNo,transactionId:remote.transaction_id,payerOpenid:remote.payer.openid,totalFen:remote.amount.total,paidAt:remote.success_time});}catch{}
  const current=db.prepare("SELECT payment_status paymentStatus,payment_method paymentMethod,paid_at paidAt,wechat_transaction_id transactionId FROM orders WHERE id=?").get(id); return NextResponse.json({ok:true,order:current,intent});
}
