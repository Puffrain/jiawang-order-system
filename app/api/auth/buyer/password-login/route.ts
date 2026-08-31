import { NextResponse } from "next/server";
import db from "@/lib/db";
import { hashPassword, passwordValidationError, verifyPassword } from "@/lib/password";
import { isPhone, normalizePhone } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { createSession } from "@/lib/session";
import { writeAudit } from "@/lib/audit";

const DUMMY_PASSWORD_HASH = hashPassword("not-a-real-customer-password");

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone), password = typeof body.password === "string" ? body.password : "", ip = requestIp(request);
  if (!isPhone(phone) || passwordValidationError(password)) return NextResponse.json({ error: "手机号或密码错误" }, { status: 401 });
  if (!consumeRateLimit("buyer-password-login-ip", ip, 30, 15 * 60) || !consumeRateLimit("buyer-password-login-account", phone, 10, 15 * 60)) return NextResponse.json({ error: "登录尝试过于频繁，请稍后再试" }, { status: 429 });
  const user = db.prepare("SELECT id,password_hash passwordHash,status FROM users WHERE phone=? AND role='buyer'").get(phone) as { id: string; passwordHash: string | null; status: string } | undefined;
  const valid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user || user.status !== "active" || !user.passwordHash || !valid) {
    writeAudit({ action: "auth.buyer.password_login.failed", objectType: "phone", ip, metadata: { reason: "invalid_credentials" } });
    return NextResponse.json({ error: "手机号或密码错误" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true, role: "buyer" });
  try { await createSession(user.id, "buyer", request, response); }
  catch { return NextResponse.json({ error: "会话密钥尚未配置，请联系商户" }, { status: 503 }); }
  writeAudit({ actorUserId: user.id, actorRole: "buyer", action: "auth.buyer.password_login", objectType: "user", objectId: user.id, ip });
  return response;
}
