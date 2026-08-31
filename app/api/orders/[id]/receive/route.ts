import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import db from '@/lib/db';
import { completeOrderPoints } from '@/lib/loyalty';
export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;const id=(await params).id;try{db.transaction(()=>{const result=db.prepare("UPDATE orders SET status='closed',customer_received_at=CURRENT_TIMESTAMP,closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND buyer_user_id=? AND fulfillment_status='delivered' AND payment_status='paid' AND status<>'closed'").run(id,auth.session!.userId);if(result.changes!==1)throw new Error('INVALID');completeOrderPoints(db,id);})();return NextResponse.json({ok:true,status:'closed'});}catch{return NextResponse.json({error:'订单尚未送达或商家尚未确认收款'},{status:409});}}
