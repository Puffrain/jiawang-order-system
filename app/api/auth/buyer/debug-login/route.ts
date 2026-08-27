import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { createSession } from "@/lib/session";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";

const DEBUG_BUYER_PHONE = "13900000000";

export async function POST(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;

  const userId = db.transaction(() => {
    const existing = db.prepare("SELECT id, role FROM users WHERE phone = ?").get(DEBUG_BUYER_PHONE) as { id: string; role: string } | undefined;
    if (existing) {
      if (existing.role !== "buyer") throw new Error("DEBUG_PHONE_CONFLICT");
      db.prepare("UPDATE users SET status='active', display_name='调试买家' WHERE id=?").run(existing.id);
      db.prepare("INSERT OR IGNORE INTO customer_profile (user_id, customer_level, internal_remark) VALUES (?, '调试客户', '仅供老板检查买家端流程')").run(existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare("INSERT INTO users (id, phone, role, display_name, tour_completed) VALUES (?, ?, 'buyer', '调试买家', 1)").run(id, DEBUG_BUYER_PHONE);
    db.prepare("INSERT INTO customer_profile (user_id, customer_level, internal_remark) VALUES (?, '调试客户', '仅供老板检查买家端流程')").run(id);
    return id;
  })();

  const response = NextResponse.json({ ok: true, role: "buyer", debug: true });
  try {
    await createSession(userId, "buyer", request, response);
  } catch {
    return NextResponse.json({ error: "会话密钥尚未配置，无法进入调试模式" }, { status: 503 });
  }
  db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?").run(auth.session.sessionId);
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "auth.debug_buyer.enter", objectType: "user", objectId: userId, ip: requestIp(request), metadata: { debugPhone: DEBUG_BUYER_PHONE } });
  return response;
}
