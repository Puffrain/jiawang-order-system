import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { buyerProfile } from "@/lib/customer-profile";
import { createSession, setSessionCookies } from "@/lib/session";

type WechatPayload = { openid?: string; errcode?: number };

async function exchangeCode(code: string) {
  const appid = process.env.WECHAT_MINI_APPID;
  const secret = process.env.WECHAT_MINI_SECRET;
  if (!appid || !secret) throw new Error("WECHAT_NOT_CONFIGURED");
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");
  const result = await fetch(url, { cache: "no-store" });
  const payload = await result.json() as WechatPayload;
  if (!result.ok || payload.errcode || !payload.openid) throw new Error("WECHAT_CODE_INVALID");
  return payload.openid;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code || code.length > 256) return NextResponse.json({ error: "微信登录凭证无效" }, { status: 400 });
  try {
    const openid = await exchangeCode(code);
    const user = db.prepare("SELECT id FROM users WHERE wechat_openid=? AND role='buyer' AND status='active'").get(openid) as { id: string } | undefined;
    if (!user) {
      const ticketId = randomUUID();
      db.prepare("DELETE FROM wechat_login_tickets WHERE datetime(expires_at)<=CURRENT_TIMESTAMP OR consumed_at IS NOT NULL").run();
      db.prepare("INSERT INTO wechat_login_tickets(id,openid,expires_at) VALUES(?,?,datetime('now','+10 minutes'))").run(ticketId, openid);
      return NextResponse.json({ ok: true, requiresPhoneBinding: true, loginTicket: ticketId, expiresIn: 600 }, { headers: { "Cache-Control": "no-store" } });
    }
    const session = await createSession(user.id, "buyer", request);
    const response = NextResponse.json({ ok: true, role: "buyer", sessionToken: session.token, expiresIn: 60 * 60 * 24 * 30, created: false, profile: buyerProfile(user.id) }, { headers: { "Cache-Control": "no-store" } });
    await setSessionCookies(response, session.token, "buyer", session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "WECHAT_NOT_CONFIGURED") return NextResponse.json({ error: "小程序服务尚未配置，请联系商户" }, { status: 503 });
    return NextResponse.json({ error: "微信登录失败，请重试" }, { status: 401 });
  }
}
