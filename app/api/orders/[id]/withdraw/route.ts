import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { withdrawOrder } from '@/lib/order-commands';
export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;try{return NextResponse.json({ok:true,...withdrawOrder((await params).id,auth.session!.userId)});}catch(error){const code=error instanceof Error?error.message:'';return NextResponse.json({error:code==='LOCKED'?'发货后不能修改订单':'当前订单不能撤回'},{status:code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:409});}}
