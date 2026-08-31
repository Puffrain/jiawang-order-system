import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { confirmByBuyer } from '@/lib/order-commands';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;const body=await request.json().catch(()=>({}));try{return NextResponse.json({ok:true,...confirmByBuyer((await params).id,auth.session!.userId,Number(body.version))});}catch(error){const code=error instanceof Error?error.message:'';return NextResponse.json({error:code==='FORBIDDEN'?'无权操作此订单':'请等待商家先确认当前订单'},{status:code==='FORBIDDEN'?403:409});}}
