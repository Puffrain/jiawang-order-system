import { NextResponse } from "next/server";
import { currentSession } from "@/lib/session";
import { buyerProfile } from "@/lib/customer-profile";
import db from "@/lib/db";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const profile=session.role==="buyer"?buyerProfile(session.userId):null;
  const hasPassword=session.role==="buyer"?Boolean((db.prepare("SELECT password_hash passwordHash FROM users WHERE id=?").get(session.userId) as {passwordHash:string|null}|undefined)?.passwordHash):true;
  return NextResponse.json({ user: { id: session.userId, phone: session.phone, role: session.role, displayName: session.displayName, tourCompleted: Boolean(session.tourCompleted), profileCompleted:profile?.profileCompleted??true, hasPassword, profile } }, { headers: { "Cache-Control": "no-store" } });
}
