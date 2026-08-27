import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { hashPassword, passwordValidationError, verifyPassword } from "@/lib/password";
import { sameOrigin, requestIp } from "@/lib/security";
import { writeAudit } from "@/lib/audit";
import { acknowledgeOwnerEnvironmentSecret } from "@/lib/bootstrap";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  const passwordError = passwordValidationError(newPassword);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  if (newPassword !== confirmPassword) return NextResponse.json({ error: "两次输入的新密码不一致" }, { status: 400 });
  if (currentPassword === newPassword) return NextResponse.json({ error: "新密码不能与当前密码相同" }, { status: 400 });
  const owner = db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id=? AND role='owner' AND status='active'").get(auth.session.userId) as { passwordHash: string } | undefined;
  if (!owner?.passwordHash || !verifyPassword(currentPassword, owner.passwordHash)) return NextResponse.json({ error: "当前密码不正确" }, { status: 401 });
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashPassword(newPassword), auth.session.userId);
    db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND id<>? AND revoked_at IS NULL").run(auth.session.userId, auth.session.sessionId);
    acknowledgeOwnerEnvironmentSecret(auth.session.userId);
  })();
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "auth.admin.password_changed", objectType: "user", objectId: auth.session.userId, ip: requestIp(request) });
  return NextResponse.json({ ok: true });
}
