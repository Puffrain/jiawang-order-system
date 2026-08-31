import { NextResponse } from "next/server";
import { ensureOwnerFromEnvironment } from "@/lib/bootstrap";
import { verifyPassword } from "@/lib/password";
import { normalizePhone, isPhone } from "@/lib/validation";
import { requestIp, sameOrigin } from "@/lib/security";
import { createSession } from "@/lib/session";
import { writeAudit } from "@/lib/audit";
import { findActiveOwnerByLoginPhone } from "@/lib/owner-login";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const ip = requestIp(request);
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  const password = String(body.password ?? "");
  if (!isPhone(phone) || password.length < 1) return NextResponse.json({ error: "手机号或密码错误" }, { status: 400 });
  const bootstrap = ensureOwnerFromEnvironment();
  if (!bootstrap.ready) return NextResponse.json({ error: bootstrap.error }, { status: 503 });
  const user = findActiveOwnerByLoginPhone(phone);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    writeAudit({ action: "auth.admin.failed", actorRole: "owner", ip, metadata: { phoneSuffix: phone.slice(-4) } });
    return NextResponse.json({ error: "手机号或密码错误" }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true, role: "owner" });
  try { await createSession(user.id, "owner", request, response); }
  catch { return NextResponse.json({ error: "会话密钥尚未配置，请设置 SESSION_SECRET" }, { status: 503 }); }
  writeAudit({ actorUserId: user.id, actorRole: "owner", action: "auth.admin.login", ip });
  return response;
}
