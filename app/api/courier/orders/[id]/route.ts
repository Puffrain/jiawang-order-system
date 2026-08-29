import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import db from '@/lib/db';

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole('courier'); if(auth.response)return auth.response;
  const id=(await params).id; const body=await request.json().catch(()=>({}));
  const action=String(body.action||''); const proof=body.proof&&typeof body.proof==='object'?JSON.stringify(body.proof).slice(0,5000):null;
  const reason=String(body.reason||'').trim().slice(0,300);
  if(action==='deliver'&&!proof)return NextResponse.json({error:'请填写签收人或送达照片地址'},{status:400});
  let result;
  if(action==='start')result=db.prepare("UPDATE orders SET fulfillment_status='out_for_delivery',delivery_started_at=COALESCE(delivery_started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND courier_user_id=? AND fulfillment_status='assigned'").run(id,auth.session!.userId);
  else if(action==='deliver')result=db.prepare("UPDATE orders SET fulfillment_status='delivered',delivered_at=CURRENT_TIMESTAMP,delivery_proof_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND courier_user_id=? AND fulfillment_status='out_for_delivery'").run(proof,id,auth.session!.userId);
  else if(action==='fail'){if(!reason)return NextResponse.json({error:'请填写配送失败原因'},{status:400});result=db.prepare("UPDATE orders SET fulfillment_status='failed',delivery_failure_reason=?,delivery_proof_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND courier_user_id=? AND fulfillment_status IN ('assigned','out_for_delivery')").run(reason,proof,id,auth.session!.userId);}
  else return NextResponse.json({error:'配送操作无效'},{status:400});
  if(result.changes!==1)return NextResponse.json({error:'订单未分配给你或状态已变化'},{status:409});
  return NextResponse.json({ok:true,action});
}
