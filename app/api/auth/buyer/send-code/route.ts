import { NextResponse } from "next/server";
import { normalizePhone, isPhone } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { createOtpChallenge, type OtpPurpose } from "@/lib/otp";
import { isSmsPreviewMode, sendVerificationSms } from "@/lib/sms";
import { writeAudit } from "@/lib/audit";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  const purpose: OtpPurpose = body.purpose === "password_reset" ? "password_reset" : body.purpose === "buyer_register" ? "buyer_register" : "buyer_access";
  if (!isPhone(phone)) return NextResponse.json({ error: "请输入正确的手机号" }, { status: 400 });
  const ip = requestIp(request);
  if (!consumeRateLimit(`otp-ip-${purpose}`, ip, 20, 60 * 60) || !consumeRateLimit(`otp-phone-${purpose}`, phone, 6, 60 * 60)) return NextResponse.json({ error: "验证码发送过于频繁，请稍后再试" }, { status: 429 });

  let challenge: ReturnType<typeof createOtpChallenge>;
  try {
    challenge = createOtpChallenge(phone, purpose);
  } catch (error) {
    console.error("OTP challenge creation failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN" });
    return NextResponse.json({ error: "验证码服务暂时不可用，请联系商户" }, { status: 503 });
  }

  const result = await sendVerificationSms(phone, challenge.code);
  if (!result.delivered) return NextResponse.json({ error: result.error || "短信发送失败，请稍后重试" }, { status: 503 });

  try {
    writeAudit({ actorRole: "system", action: `auth.otp.${purpose}.sent`, objectType: "phone", ip, metadata: { purpose } });
  } catch (error) {
    console.error("OTP audit write failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN" });
  }
  return NextResponse.json({ ok: true, challengeId: challenge.id, expiresIn: 300, ...(isSmsPreviewMode() ? { developmentCode: result.developmentCode } : {}) });
}
