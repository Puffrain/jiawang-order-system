import { NextResponse } from "next/server";
import { createOtpChallenge } from "@/lib/otp";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { isSmsPreviewMode, sendVerificationSms } from "@/lib/sms";
import { isPhone, normalizePhone } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { ensureOwnerFromEnvironment } from "@/lib/bootstrap";
import { findActiveOwnerByLoginPhone } from "@/lib/owner-login";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!isPhone(phone)) return NextResponse.json({ error: "请输入正确的手机号" }, { status: 400 });
  const ip = requestIp(request);
  if (!consumeRateLimit("owner-reset-code-ip", ip, 10, 60 * 60) || !consumeRateLimit("owner-reset-code-phone", phone, 5, 60 * 60)) {
    return NextResponse.json({ error: "验证码发送过于频繁，请稍后再试" }, { status: 429 });
  }
  const bootstrap = ensureOwnerFromEnvironment();
  if (!bootstrap.ready) return NextResponse.json({ error: bootstrap.error }, { status: 503 });
  const owner = findActiveOwnerByLoginPhone(phone);
  if (!owner) return NextResponse.json({ error: "该手机号不是老板账号" }, { status: 400 });
  try {
    const challenge = createOtpChallenge(phone, "owner_password_reset");
    const result = await sendVerificationSms(phone, challenge.code);
    if (!result.delivered) return NextResponse.json({ error: result.error }, { status: 503 });
    writeAudit({ action: "auth.admin.password_reset_code.sent", actorRole: "owner", objectType: "phone", ip });
    return NextResponse.json({ ok: true, challengeId: challenge.id, expiresIn: 300, ...(isSmsPreviewMode() ? { developmentCode: result.developmentCode } : {}) });
  } catch {
    return NextResponse.json({ error: "验证码服务尚未完成安全配置" }, { status: 503 });
  }
}
