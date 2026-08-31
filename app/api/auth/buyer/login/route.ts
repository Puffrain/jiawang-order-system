import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { normalizePhone, isPhone, isSixDigitCode } from "@/lib/validation";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp, sameOrigin } from "@/lib/security";
import { verifyOtpChallenge } from "@/lib/otp";
import { createSession } from "@/lib/session";
import { writeAudit } from "@/lib/audit";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone), code = String(body.code ?? ""), challengeId = String(body.challengeId ?? ""), ip = requestIp(request);
  if (!isPhone(phone) || !isSixDigitCode(code) || !challengeId) return NextResponse.json({ error: "验证码无效或已过期" }, { status: 400 });
  if (!consumeRateLimit("otp-verify", `${ip}:${phone}`, 10, 15 * 60)) return NextResponse.json({ error: "验证次数过多，请稍后再试" }, { status: 429 });
  if (!verifyOtpChallenge(challengeId, phone, "buyer_access", code)) {
    writeAudit({ action: "auth.buyer.sms_login.failed", objectType: "phone", ip, metadata: { reason: "invalid_code" } });
    return NextResponse.json({ error: "验证码无效或已过期" }, { status: 401 });
  }
  let user = db.prepare("SELECT id FROM users WHERE phone=? AND role='buyer' AND status='active'").get(phone) as { id: string } | undefined;
  let created = false;
  if (!user) {
    const id = randomUUID();
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO users(id,phone,role,password_hash,display_name) VALUES(?,?,'buyer',NULL,?)").run(id, phone, `客户${phone.slice(-4)}`);
        db.prepare("INSERT INTO customer_profile(user_id) VALUES(?)").run(id);
      })();
      user = { id };
      created = true;
    } catch {
      user = db.prepare("SELECT id FROM users WHERE phone=? AND role='buyer' AND status='active'").get(phone) as { id: string } | undefined;
      if (!user) return NextResponse.json({ error: "暂时无法创建客户账号，请稍后再试" }, { status: 500 });
    }
  }
  const response = NextResponse.json({ ok: true, role: "buyer" });
  try { await createSession(user.id, "buyer", request, response); }
  catch { return NextResponse.json({ error: "会话密钥尚未配置，请联系商户" }, { status: 503 }); }
  writeAudit({ actorUserId: user.id, actorRole: "buyer", action: created ? "auth.buyer.auto_register" : "auth.buyer.sms_login", ip });
  return response;
}
