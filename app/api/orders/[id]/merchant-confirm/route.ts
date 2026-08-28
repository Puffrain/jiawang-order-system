import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { confirmByMerchant } from '@/lib/order-commands';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('owner');if(auth.response)return auth.response;const body=await request.json().catch(()=>({}));try{return NextResponse.json({ok:true,...confirmByMerchant((await params).id,Number(body.version))});}catch{return NextResponse.json({error:'订单版本已更新或当前不能确认'},{status:409});}}
