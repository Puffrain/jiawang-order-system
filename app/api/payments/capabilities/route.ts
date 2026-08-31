import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
import { getWechatPayConfigStatus } from '@/lib/wechat-pay-config';

export async function GET(){
  const auth=await requireApiRole('buyer');
  if(auth.response)return auth.response;
  const status=getWechatPayConfigStatus();
  return NextResponse.json({wechat:{available:status.ready,status:status.ready?'ready':'NOT_CONFIGURED',missing:status.ready?[]:status.missing},onsite:{available:true,status:'ready'}});
}
