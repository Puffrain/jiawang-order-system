import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { ownerUserId } from "@/lib/chat-events";
import { cleanText } from "@/lib/validation";
import { chatStatusContent, orderStatusLabel } from "@/lib/order-status";
import { activeBuyer, insertChatMessage } from "@/lib/chat-messages";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { notifyCustomerMessage } from "@/lib/wecom";

type MessageRow = Record<string, unknown> & { id: number; payloadJson: string | null; content: string; orderStatus?: string };

export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const query = new URL(request.url).searchParams;
  const buyerUserId = auth.session.role === "buyer" ? auth.session.userId : cleanText(query.get("buyerUserId"),100);
  const afterId = Math.max(0,Number(query.get("afterId") || 0) || 0);
  if (!buyerUserId) return NextResponse.json({ error: "请选择客户会话" },{ status: 400 });
  if (auth.session.role === "owner" && !db.prepare("SELECT id FROM users WHERE id=? AND role='buyer'").get(buyerUserId)) return NextResponse.json({ error: "客户不存在" },{ status: 404 });
  const ownerId = auth.session.role === "owner" ? auth.session.userId : ownerUserId();
  if (!ownerId) return NextResponse.json({ messages: [], cursor: afterId });
  const clearBeforeId = auth.session.role === "owner" ? Number((db.prepare("SELECT owner_clear_before_id clearBeforeId FROM im_conversation WHERE user_id=? AND target_id=?").get(ownerId,buyerUserId) as { clearBeforeId?: number } | undefined)?.clearBeforeId || 0) : 0;
  const lowerBound = Math.max(afterId,clearBeforeId);
  const select = `SELECT m.id,m.from_user_id fromUserId,m.to_user_id toUserId,m.order_id orderId,m.msg_type type,m.content,m.payload_json payloadJson,m.quote_version quoteVersion,m.is_read isRead,m.read_at readAt,m.created_at createdAt,o.order_no orderNo,o.total_amount orderTotal,o.status orderStatus FROM im_message m LEFT JOIN orders o ON o.id=m.order_id WHERE ((m.from_user_id=? AND m.to_user_id=?) OR (m.from_user_id=? AND m.to_user_id=?))`;
  let messages: MessageRow[];
  if (lowerBound > 0) messages = db.prepare(`${select} AND m.id>? ORDER BY m.id ASC LIMIT 100`).all(ownerId,buyerUserId,buyerUserId,ownerId,lowerBound) as MessageRow[];
  else messages = (db.prepare(`${select} ORDER BY m.id DESC LIMIT 100`).all(ownerId,buyerUserId,buyerUserId,ownerId) as MessageRow[]).reverse();
  const normalized = messages.map(message => {
    let payload: unknown = null;
    try { payload = message.payloadJson ? JSON.parse(message.payloadJson) : null; } catch {}
    if (message.type === "image" && payload && typeof payload === "object") payload = { ...(payload as Record<string,unknown>), fileName: undefined, mediaId: message.id, mediaUrl: `/api/chat/media/${message.id}` };
    return { ...message, content: chatStatusContent(message.content,payload,message.orderStatus), statusLabel: message.orderStatus ? orderStatusLabel(message.orderStatus) : undefined, payload, payloadJson: undefined };
  });
  return NextResponse.json({ buyerUserId, messages: normalized, cursor: normalized.at(-1)?.id || lowerBound, hasMore: messages.length === 100 },{ headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const content = cleanText(body.content,1000), clientMessageId = cleanText(body.clientMessageId,100);
  if (!content) return NextResponse.json({ error: "请输入消息内容" },{ status: 400 });
  if (!clientMessageId) return NextResponse.json({ error: "消息编号缺失" },{ status: 400 });
  const ownerId = auth.session.role === "owner" ? auth.session.userId : ownerUserId();
  const buyerUserId = auth.session.role === "buyer" ? auth.session.userId : cleanText(body.buyerUserId,100);
  if (!ownerId || !buyerUserId) return NextResponse.json({ error: "会话对象不存在" },{ status: 404 });
  if (!activeBuyer(buyerUserId)) return NextResponse.json({ error: "客户不存在或已停用" },{ status: 404 });
  const result = insertChatMessage({ fromUserId: auth.session.userId, toUserId: auth.session.role === "owner" ? buyerUserId : ownerId, buyerUserId, type: "text", content, eventKey: `text:${auth.session.userId}:${clientMessageId}` });
  if (auth.session.role === "owner" && !result.replayed) writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "chat.proactive.text.sent", objectType: "im_message", objectId: String(result.id), ip: requestIp(request), metadata: { buyerUserId } });
  if (auth.session.role === "buyer" && !result.replayed) {
    const customer = db.prepare("SELECT u.display_name displayName,u.phone,p.shop_name shopName FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id WHERE u.id=?").get(buyerUserId) as { displayName: string | null; phone: string | null; shopName: string | null } | undefined;
    const orderNo = db.prepare("SELECT order_no orderNo FROM im_message m LEFT JOIN orders o ON o.id=m.order_id WHERE m.id=?").get(result.id) as { orderNo: string | null } | undefined;
    if (customer) void notifyCustomerMessage({ customer, messageType: "文字", content, orderNo: orderNo?.orderNo });
  }
  return NextResponse.json({ ok: true, id: result.id, replayed: result.replayed });
}
