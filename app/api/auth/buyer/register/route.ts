import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { hashPassword, passwordValidationError } from "@/lib/password";
import { isPhone, isSixDigitCode, normalizePhone } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { createSession } from "@/lib/session";
import { writeAudit } from "@/lib/audit";
import { verifyOtpChallenge } from "@/lib/otp";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone), password = typeof body.password === "string" ? body.password : "", confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "", code = String(body.code ?? ""), challengeId = String(body.challengeId ?? ""), ip = requestIp(request);
  if (!isPhone(phone)) return NextResponse.json({ error: "请输入正确的手机号" }, { status: 400 });
  if (!isSixDigitCode(code) || !challengeId || !verifyOtpChallenge(challengeId, phone, "buyer_register", code)) return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  if (password) {
    const passwordError = passwordValidationError(password);
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
    if (password !== confirmPassword) return NextResponse.json({ error: "两次输入的密码不一致" }, { status: 400 });
  } else if (confirmPassword) return NextResponse.json({ error: "请填写密码或清空确认密码" }, { status: 400 });
  if (!consumeRateLimit("buyer-register-ip", ip, 12, 60 * 60) || !consumeRateLimit("buyer-register-phone", phone, 4, 24 * 60 * 60)) return NextResponse.json({ error: "注册操作过于频繁，请稍后再试" }, { status: 429 });
  let userId = "";
  try {
    userId = db.transaction(() => {
      if (db.prepare("SELECT id FROM users WHERE phone=?").get(phone)) throw new Error("PHONE_EXISTS");
      const id = randomUUID();
      db.prepare("INSERT INTO users(id,phone,role,password_hash,display_name) VALUES(?,?,'buyer',?,?)").run(id, phone, password ? hashPassword(password) : null, `客户${phone.slice(-4)}`);
      db.prepare("INSERT INTO customer_profile(user_id) VALUES(?)").run(id);
      return id;
    })();
  } catch (error) {
    writeAudit({ action: "auth.buyer.register.failed", objectType: "phone", ip, metadata: { reason: error instanceof Error && error.message === "PHONE_EXISTS" ? "phone_exists" : "storage_error" } });
    if (error instanceof Error && (error.message === "PHONE_EXISTS" || error.message.includes("UNIQUE"))) return NextResponse.json({ error: "该手机号已注册，请直接登录" }, { status: 409 });
    return NextResponse.json({ error: "暂时无法完成注册，请稍后再试" }, { status: 500 });
  }
  const response = NextResponse.json({ ok: true, role: "buyer" }, { status: 201 });
  try { await createSession(userId, "buyer", request, response); }
  catch { return NextResponse.json({ error: "账号已创建，但会话服务尚未配置，请使用密码登录" }, { status: 503 }); }
  writeAudit({ actorUserId: userId, actorRole: "buyer", action: "auth.buyer.register", objectType: "user", objectId: userId, ip });
  return response;
}
