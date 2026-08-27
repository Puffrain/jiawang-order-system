import { NextResponse } from "next/server";
import db from "@/lib/db";
import { hashPassword, passwordValidationError } from "@/lib/password";
import { verifyOtpChallenge } from "@/lib/otp";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { isPhone, isSixDigitCode, normalizePhone } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { acknowledgeOwnerEnvironmentSecret, ensureOwnerFromEnvironment } from "@/lib/bootstrap";
import { findActiveOwnerByLoginPhone } from "@/lib/owner-login";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  const code = String(body.code ?? "");
  const challengeId = String(body.challengeId ?? "");
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const ip = requestIp(request);
  if (!isPhone(phone) || !isSixDigitCode(code) || !challengeId) return NextResponse.json({ error: "验证码无效或已过期" }, { status: 400 });
  const passwordError = passwordValidationError(password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (password !== confirmPassword) return NextResponse.json({ error: "两次输入的新密码不一致" }, { status: 400 });
  if (!consumeRateLimit("owner-password-reset", `${ip}:${phone}`, 6, 30 * 60)) return NextResponse.json({ error: "重置尝试过于频繁，请稍后再试" }, { status: 429 });
  const bootstrap = ensureOwnerFromEnvironment();
  if (!bootstrap.ready) return NextResponse.json({ error: bootstrap.error }, { status: 503 });
  if (!verifyOtpChallenge(challengeId, phone, "owner_password_reset", code)) {
    writeAudit({ action: "auth.admin.password_reset.failed", actorRole: "owner", objectType: "phone", ip, metadata: { reason: "invalid_code" } });
    return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  }
  const owner = findActiveOwnerByLoginPhone(phone);
  if (!owner) return NextResponse.json({ error: "无法重置该账号密码" }, { status: 400 });
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(password), owner.id);
    db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").run(owner.id);
    acknowledgeOwnerEnvironmentSecret(owner.id);
  })();
  writeAudit({ actorUserId: owner.id, actorRole: "owner", action: "auth.admin.password_reset", objectType: "user", objectId: owner.id, ip });
  return NextResponse.json({ ok: true });
}
