import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { cancelCustomerOrder } from '@/lib/order-commands';
export async function POST(_:Request,{params}:{params:Promise<{id:string}>}){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;try{return NextResponse.json(cancelCustomerOrder((await params).id,auth.session!.userId));}catch(error){const code=error instanceof Error?error.message:'';return NextResponse.json({error:code==='FORBIDDEN'?'无权操作此订单':code==='NOT_FOUND'?'订单不存在':'发货后不能取消订单'},{status:code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:409});}}
