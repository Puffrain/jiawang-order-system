import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import db from '@/lib/db';
import { commitOrderPoints } from '@/lib/loyalty';

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole('owner'); if(auth.response)return auth.response;
  const body=await request.json().catch(()=>({})); const method=String(body.method||'onsite');
  if(!['onsite','wechat','alipay'].includes(method))return NextResponse.json({error:'支付方式无效'},{status:400});
  if(method==='wechat'&&!process.env.WECHAT_PAY_MERCHANT_ID)return NextResponse.json({error:'微信支付尚未配置'},{status:409});
  if(method==='alipay'&&!process.env.ALIPAY_APP_ID)return NextResponse.json({error:'支付宝尚未配置'},{status:409});
  const id=(await params).id;
  try { db.transaction(()=>{const result=db.prepare("UPDATE orders SET payment_status='paid',payment_method=?,paid_at=CURRENT_TIMESTAMP,payment_confirmed_by=?,status=CASE WHEN status='pending_payment' THEN 'pending_shipment' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL AND payment_status<>'paid' AND status IN ('pending_payment','pending_shipment')").run(method,auth.session!.userId,id);if(result.changes!==1)throw new Error('INVALID');commitOrderPoints(db,id);})(); }
  catch{return NextResponse.json({error:'当前订单不能确认收款'},{status:409});}
  return NextResponse.json({ok:true,paymentStatus:'paid',paymentMethod:method});
}
