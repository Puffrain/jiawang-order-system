import { NextResponse } from "next/server";
import { currentSession } from "@/lib/session";

export async function requireApiRole(role?: "owner" | "buyer" | "courier") {
  const session = await currentSession();
  if (!session) return { session: null, response: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  if (role && session.role !== role) return { session: null, response: NextResponse.json({ error: "无权执行此操作" }, { status: 403 }) };
  return { session, response: null };
}

export async function requirePageRole(role: "owner" | "buyer") {
  const session = await currentSession();
  return session?.role === role ? session : null;
}
