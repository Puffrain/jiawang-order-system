import { NextResponse } from "next/server";
import db from "@/lib/db";
import { currentSession } from "@/lib/session";
import { hashPassword, passwordValidationError } from "@/lib/password";
import { isSixDigitCode } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { verifyOtpChallenge } from "@/lib/otp";
import { writeAudit } from "@/lib/audit";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const session = await currentSession();
  if (!session || session.role !== "buyer") return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const code = String(body.code ?? "");
  const challengeId = String(body.challengeId ?? "");
  const ip = requestIp(request);
  const passwordError = passwordValidationError(password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (password !== confirmPassword) return NextResponse.json({ error: "两次输入的密码不一致" }, { status: 400 });
  if (!consumeRateLimit("buyer-password-set", `${ip}:${session.userId}`, 8, 30 * 60)) return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  const row = db.prepare("SELECT password_hash passwordHash FROM users WHERE id=? AND role='buyer' AND status='active'").get(session.userId) as { passwordHash: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "客户账号不可用" }, { status: 400 });
  if (row.passwordHash && (!isSixDigitCode(code) || !challengeId || !verifyOtpChallenge(challengeId, session.phone, "password_reset", code))) {
    writeAudit({ actorUserId: session.userId, actorRole: "buyer", action: "auth.buyer.password_change.failed", objectType: "user", objectId: session.userId, ip, metadata: { reason: "invalid_code" } });
    return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  }
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(password), session.userId);
    if (row.passwordHash) db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND id<>? AND revoked_at IS NULL").run(session.userId, session.sessionId);
  })();
  writeAudit({ actorUserId: session.userId, actorRole: "buyer", action: row.passwordHash ? "auth.buyer.password_change" : "auth.buyer.password_set", objectType: "user", objectId: session.userId, ip });
  return NextResponse.json({ ok: true, hasPassword: true });
}
