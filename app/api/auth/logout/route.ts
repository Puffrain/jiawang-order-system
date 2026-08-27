import { NextResponse } from "next/server";
import { revokeCurrentSession } from "@/lib/session";
import { sameOrigin } from "@/lib/security";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  await revokeCurrentSession(response);
  return response;
}
