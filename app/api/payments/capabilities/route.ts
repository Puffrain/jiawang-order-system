import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth';
export async function GET(){const auth=await requireApiRole('buyer');if(auth.response)return auth.response;const ready=Boolean(process.env.WECHAT_PAY_MERCHANT_ID&&process.env.WECHAT_PAY_API_V3_KEY&&process.env.WECHAT_PAY_PRIVATE_KEY_FILE);return NextResponse.json({wechat:{available:ready,status:ready?'ready':'NOT_CONFIGURED'},onsite:{available:true,status:'ready'}});}
