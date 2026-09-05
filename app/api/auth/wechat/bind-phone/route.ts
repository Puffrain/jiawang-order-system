import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { createSession, setSessionCookies } from "@/lib/session";
import { verifyOtpChallenge } from "@/lib/otp";
import { isPhone, isSixDigitCode, normalizePhone } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/security";
import { buyerProfile } from "@/lib/customer-profile";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const ticketId = typeof body.loginTicket === "string" ? body.loginTicket : "";
  const phone = normalizePhone(body.phone);
  const code = String(body.code ?? "");
  const challengeId = String(body.challengeId ?? "");
  const ip = requestIp(request);
  if (!ticketId || !isPhone(phone) || !isSixDigitCode(code) || !challengeId) return NextResponse.json({ error: "手机号或验证码无效" }, { status: 400 });
  if (!consumeRateLimit("wechat-bind-verify", `${ip}:${phone}`, 10, 15 * 60)) return NextResponse.json({ error: "验证次数过多，请稍后重试" }, { status: 429 });
  if (!verifyOtpChallenge(challengeId, phone, "wechat_bind", code)) return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  try {
    const result = db.transaction(() => {
      const ticket = db.prepare("SELECT openid FROM wechat_login_tickets WHERE id=? AND consumed_at IS NULL AND datetime(expires_at)>CURRENT_TIMESTAMP").get(ticketId) as { openid: string } | undefined;
      if (!ticket) throw new Error("TICKET_INVALID");
      const openidOwner = db.prepare("SELECT id FROM users WHERE wechat_openid=?").get(ticket.openid) as { id: string } | undefined;
      if (openidOwner) throw new Error("OPENID_BOUND");
      let user = db.prepare("SELECT id,status FROM users WHERE phone=? AND role='buyer'").get(phone) as { id: string; status: string } | undefined;
      let created = false;
      if (user && user.status !== "active") throw new Error("USER_DISABLED");
      if (!user) {
        const id = randomUUID();
        db.prepare("INSERT INTO users(id,phone,role,password_hash,display_name,wechat_openid) VALUES(?,?, 'buyer', NULL, ?, ?)").run(id, phone, `客户${phone.slice(-4)}`, ticket.openid);
        db.prepare("INSERT INTO customer_profile(user_id) VALUES(?)").run(id);
        user = { id, status: "active" };
        created = true;
      } else db.prepare("UPDATE users SET wechat_openid=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND wechat_openid IS NULL").run(ticket.openid, user.id);
      db.prepare("UPDATE wechat_login_tickets SET consumed_at=CURRENT_TIMESTAMP WHERE id=?").run(ticketId);
      return { userId: user.id, created };
    })();
    const session = await createSession(result.userId, "buyer", request);
    const response = NextResponse.json({ ok: true, role: "buyer", sessionToken: session.token, expiresIn: 60 * 60 * 24 * 30, created: result.created, profile: buyerProfile(result.userId) }, { headers: { "Cache-Control": "no-store" } });
    await setSessionCookies(response, session.token, "buyer", session.expiresAt);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const errorText = message === "TICKET_INVALID" ? "微信登录已过期，请重新登录" : message === "USER_DISABLED" ? "该手机号账号已停用，请联系商户" : message === "OPENID_BOUND" ? "该微信已绑定其他账号，请重新登录" : "手机号绑定失败，请重试";
    return NextResponse.json({ error: errorText }, { status: 409 });
  }
}
