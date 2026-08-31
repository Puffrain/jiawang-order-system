import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { verifyIntegrationRequest } from "@/lib/integration-auth";

export async function POST(request:Request){
  const raw=await request.text();
  if(!verifyIntegrationRequest(request,raw))return NextResponse.json({error:"unauthorized"},{status:401});
  const token=String((JSON.parse(raw||"{}") as {token?:string}).token||"");
  if(token.length<32||token.length>256)return NextResponse.json({authenticated:false});
  const hash=createHash("sha256").update(token).digest("hex");
  const owner=db.prepare(`SELECT u.id,u.phone,u.display_name displayName FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND u.status='active' AND u.role='owner'`).get(hash);
  return NextResponse.json(owner?{authenticated:true,user:owner}:{authenticated:false});
}
