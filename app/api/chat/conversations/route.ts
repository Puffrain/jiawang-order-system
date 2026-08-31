import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { ownerUserId } from "@/lib/chat-events";
import { cleanText } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";

export async function GET() {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  if (auth.session.role === "buyer") {
    const ownerId = ownerUserId();
    if (!ownerId) return NextResponse.json({ conversations: [], unreadTotal: 0 });
    const row = db.prepare(`SELECT ? buyerUserId,u.display_name customerName,p.shop_name shopName,u.phone,c.last_msg lastMessage,c.unread_count unreadCount,c.updated_at updatedAt FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id LEFT JOIN im_conversation c ON c.user_id=? AND c.target_id=? WHERE u.id=?`).get(auth.session.userId,auth.session.userId,ownerId,auth.session.userId);
    return NextResponse.json({ conversations: row ? [row] : [], unreadTotal: (row as { unreadCount?: number } | undefined)?.unreadCount || 0 },{ headers: { "Cache-Control": "no-store" } });
  }
  const conversations = db.prepare(`SELECT c.target_id buyerUserId,u.display_name customerName,p.shop_name shopName,u.phone,c.last_msg lastMessage,c.unread_count unreadCount,c.updated_at updatedAt,(SELECT order_id FROM im_message m WHERE ((m.from_user_id=c.user_id AND m.to_user_id=c.target_id) OR (m.from_user_id=c.target_id AND m.to_user_id=c.user_id)) AND m.id>c.owner_clear_before_id ORDER BY m.id DESC LIMIT 1) lastOrderId FROM im_conversation c JOIN users u ON u.id=c.target_id LEFT JOIN customer_profile p ON p.user_id=u.id WHERE c.user_id=? AND c.owner_hidden_at IS NULL AND u.role='buyer' ORDER BY c.updated_at DESC`).all(auth.session.userId);
  const unreadTotal = (conversations as Array<{ unreadCount: number }>).reduce((sum,row) => sum + Number(row.unreadCount || 0),0);
  return NextResponse.json({ conversations, unreadTotal },{ headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const buyerUserId = cleanText(body.buyerUserId,100);
  const action = body.action === "clear" || body.action === "hide" ? body.action : null;
  if (!action) return NextResponse.json({ error: "会话操作无效" },{ status: 400 });
  const buyerExists = buyerUserId && db.prepare("SELECT id FROM users WHERE id=? AND role='buyer'").get(buyerUserId);
  if (!buyerExists) return NextResponse.json({ error: "客户不存在" },{ status: 404 });
  let clearBeforeId = 0;
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO im_conversation(user_id,target_id,last_msg,unread_count) VALUES(?,?,'',0)").run(auth.session.userId,buyerUserId);
    if (action === "clear") {
      clearBeforeId = Number((db.prepare(`SELECT COALESCE(MAX(id),0) id FROM im_message WHERE (from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)`).get(auth.session.userId,buyerUserId,buyerUserId,auth.session.userId) as { id: number }).id);
      db.prepare("UPDATE im_conversation SET owner_clear_before_id=MAX(owner_clear_before_id,?),last_msg='',unread_count=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND target_id=?").run(clearBeforeId,auth.session.userId,buyerUserId);
    } else {
      db.prepare("UPDATE im_conversation SET owner_hidden_at=CURRENT_TIMESTAMP,unread_count=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND target_id=?").run(auth.session.userId,buyerUserId);
    }
  })();
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: `chat.conversation.${action}`, objectType: "im_conversation", objectId: buyerUserId, ip: requestIp(request), metadata: action === "clear" ? { clearBeforeId } : undefined });
  return NextResponse.json({ ok: true, action, clearBeforeId: action === "clear" ? clearBeforeId : undefined });
}
