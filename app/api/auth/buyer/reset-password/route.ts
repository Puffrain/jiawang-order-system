import { NextResponse } from "next/server";
import db from "@/lib/db";
import { hashPassword, passwordValidationError } from "@/lib/password";
import { isPhone, isSixDigitCode, normalizePhone } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { verifyOtpChallenge } from "@/lib/otp";
import { writeAudit } from "@/lib/audit";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone), code = String(body.code ?? ""), challengeId = String(body.challengeId ?? ""), password = typeof body.password === "string" ? body.password : "", confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "", ip = requestIp(request);
  if (!isPhone(phone) || !isSixDigitCode(code) || !challengeId) return NextResponse.json({ error: "验证码无效或已过期" }, { status: 400 });
  const passwordError = passwordValidationError(password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (password !== confirmPassword) return NextResponse.json({ error: "两次输入的密码不一致" }, { status: 400 });
  if (!consumeRateLimit("buyer-password-reset", `${ip}:${phone}`, 8, 30 * 60)) return NextResponse.json({ error: "重置尝试过于频繁，请稍后再试" }, { status: 429 });
  if (!verifyOtpChallenge(challengeId, phone, "password_reset", code)) {
    writeAudit({ action: "auth.buyer.password_reset.failed", objectType: "phone", ip, metadata: { reason: "invalid_code" } });
    return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  }
  const user = db.prepare("SELECT id FROM users WHERE phone=? AND role='buyer' AND status='active'").get(phone) as { id: string } | undefined;
  if (!user) return NextResponse.json({ error: "无法重置该账号密码" }, { status: 400 });
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(password), user.id);
    db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").run(user.id);
  })();
  writeAudit({ actorUserId: user.id, actorRole: "buyer", action: "auth.buyer.password_reset", objectType: "user", objectId: user.id, ip });
  return NextResponse.json({ ok: true });
}
