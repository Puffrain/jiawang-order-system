import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import db from "@/lib/db";
import { randomUUID } from "node:crypto";
import { hashPassword, passwordValidationError } from "@/lib/password";
import { isPhone, normalizePhone } from "@/lib/validation";
export async function GET(){const auth=await requireApiRole("owner");if(auth.response)return auth.response;const couriers=db.prepare("SELECT id,display_name displayName,phone FROM users WHERE role='courier' AND status='active' ORDER BY display_name,phone").all();return NextResponse.json({couriers});}
export async function POST(request:Request){const auth=await requireApiRole("owner");if(auth.response)return auth.response;const body=await request.json().catch(()=>({}));const phone=normalizePhone(body.phone),displayName=String(body.displayName||'').trim().slice(0,50),password=String(body.password||'');if(!isPhone(phone)||!displayName)return NextResponse.json({error:'请填写送货员姓名和正确手机号'},{status:400});const passwordError=passwordValidationError(password);if(passwordError)return NextResponse.json({error:passwordError},{status:400});try{const id=randomUUID();db.prepare("INSERT INTO users(id,phone,role,display_name,password_hash,status) VALUES(?,?,'courier',?,?, 'active')").run(id,phone,displayName,hashPassword(password));return NextResponse.json({ok:true,courier:{id,phone,displayName}},{status:201});}catch{return NextResponse.json({error:'该手机号已被使用'},{status:409});}}
