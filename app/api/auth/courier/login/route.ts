import { NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/password';
import { normalizePhone, isPhone } from '@/lib/validation';
import { sameOrigin, requestIp } from '@/lib/security';
import { createSession } from '@/lib/session';
import { writeAudit } from '@/lib/audit';
import db from '@/lib/db';
export async function POST(request:Request){if(!sameOrigin(request))return NextResponse.json({error:'请求来源无效'},{status:403});const body=await request.json().catch(()=>({}));const phone=normalizePhone(body.phone);const password=String(body.password||'');if(!isPhone(phone)||!password)return NextResponse.json({error:'手机号或密码错误'},{status:400});const user=db.prepare("SELECT id,password_hash passwordHash FROM users WHERE phone=? AND role='courier' AND status='active'").get(phone) as {id:string;passwordHash:string|null}|undefined;if(!user||!user.passwordHash||!verifyPassword(password,user.passwordHash)){writeAudit({action:'auth.courier.failed',actorRole:'courier',ip:requestIp(request),metadata:{phoneSuffix:phone.slice(-4)}});return NextResponse.json({error:'手机号或密码错误'},{status:401});}const session=await createSession(user.id,'courier',request);const response=NextResponse.json({ok:true,role:'courier',sessionToken:session.token,expiresIn:60*60*24*30});writeAudit({actorUserId:user.id,actorRole:'courier',action:'auth.courier.login',ip:requestIp(request)});return response;}
