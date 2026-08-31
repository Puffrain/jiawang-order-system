import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { hideCustomerOrder } from '@/lib/order-commands';
export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;try{return NextResponse.json(hideCustomerOrder((await params).id,auth.session!.userId));}catch(error){const code=error instanceof Error?error.message:'';return NextResponse.json({error:code==='FORBIDDEN'?'无权操作此订单':'订单不存在'},{status:code==='FORBIDDEN'?403:404});}}
