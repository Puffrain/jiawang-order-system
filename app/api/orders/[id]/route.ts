import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { cleanText } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { orderStatusLabel } from "@/lib/order-status";

export async function GET(_:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole();if(auth.response)return auth.response;const{id}=await params;
  const order=db.prepare("SELECT o.id,o.order_no orderNo,o.buyer_user_id buyerUserId,o.status,o.subtotal,o.discount_amount discountAmount,o.discount_rate discountRate,o.manual_reduction manualReduction,o.points_used pointsUsed,o.points_discount pointsDiscount,o.shipping_fee shippingFee,o.total_amount totalAmount,o.quote_version quoteVersion,o.confirmed_quote_version confirmedQuoteVersion,o.recipient_snapshot recipientSnapshot,o.customer_remark customerRemark,o.created_at createdAt,o.updated_at updatedAt,o.closed_at closedAt,o.deleted_at deletedAt,o.deleted_reason deletedReason,u.display_name buyerName,u.phone buyerPhone,p.shop_name shopName FROM orders o JOIN users u ON u.id=o.buyer_user_id LEFT JOIN customer_profile p ON p.user_id=u.id WHERE o.id=?").get(id) as Record<string,unknown>&{buyerUserId:string;deletedAt:string|null;status:string;quoteVersion:number;confirmedQuoteVersion:number}|undefined;
  if(!order||auth.session.role==="buyer"&&order.deletedAt)return NextResponse.json({error:"订单不存在"},{status:404});
  if(auth.session.role==="buyer"&&order.buyerUserId!==auth.session.userId)return NextResponse.json({error:"无权查看此订单"},{status:403});
  const items=db.prepare("SELECT id,sku_id skuId,sku_code skuCode,product_name productName,spec_name specName,quantity,list_price listPrice,unit_price unitPrice,line_total lineTotal FROM order_items WHERE order_id=?").all(id);
  const quotes=db.prepare("SELECT version,subtotal,discount_rate discountRate,manual_reduction manualReduction,points_used pointsUsed,points_discount pointsDiscount,shipping_fee shippingFee,total_amount totalAmount,reason,confirmed_at confirmedAt,created_at createdAt FROM order_quotes WHERE order_id=? ORDER BY version DESC").all(id);
  const priceLogs=db.prepare("SELECT old_total oldTotal,new_total newTotal,adjust_reason reason,created_at createdAt FROM order_price_log WHERE order_id=? ORDER BY created_at DESC").all(id);
  return NextResponse.json({order:{...order,statusLabel:orderStatusLabel(order.status,{quoteVersion:order.quoteVersion,confirmedQuoteVersion:order.confirmedQuoteVersion}),recipientSnapshot:JSON.parse(String(order.recipientSnapshot)),items,quotes,priceLogs}},{headers:{"Cache-Control":"no-store"}});
}

export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole("owner");if(auth.response)return auth.response;const{id}=await params;const body=await request.json().catch(()=>({}));const reason=cleanText(body.reason,200)||"老板从在线列表删除";
  const result=db.transaction(()=>{
    const order=db.prepare("SELECT status,deleted_at deletedAt FROM orders WHERE id=?").get(id) as {status:string;deletedAt:string|null}|undefined;
    if(!order||order.deletedAt)return {code:"NOT_FOUND" as const};
    if(order.status!=="closed")return {code:"ACTIVE" as const};
    db.prepare("UPDATE orders SET deleted_at=CURRENT_TIMESTAMP,deleted_by=?,deleted_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").run(auth.session.userId,reason,id);
    return {code:"OK" as const};
  })();
  if(result.code==="NOT_FOUND")return NextResponse.json({error:"订单不存在或已删除"},{status:404});
  if(result.code==="ACTIVE")return NextResponse.json({error:"请先关闭或完成订单，再进行归档"},{status:409});
  writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"order.deleted",objectType:"order",objectId:id,ip:requestIp(request),metadata:{reason}});
  return NextResponse.json({ok:true});
}
