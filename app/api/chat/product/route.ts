import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { cleanText } from "@/lib/validation";
import { activeBuyer, insertChatMessage, productSnapshot } from "@/lib/chat-messages";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";

export async function POST(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const buyerUserId = cleanText(body.buyerUserId,100), productId = cleanText(body.productId,100), clientMessageId = cleanText(body.clientMessageId,100);
  if (!buyerUserId || !activeBuyer(buyerUserId)) return NextResponse.json({ error: "客户不存在或已停用" },{ status: 404 });
  if (!clientMessageId) return NextResponse.json({ error: "消息编号缺失" },{ status: 400 });
  const snapshot = productSnapshot(productId);
  if (!snapshot) return NextResponse.json({ error: "商品不存在或未上架" },{ status: 404 });
  const result = insertChatMessage({ fromUserId: auth.session.userId, toUserId: buyerUserId, buyerUserId, type: "product", content: `[商品推荐] ${String(snapshot.name)}`, payload: { product: snapshot }, eventKey: `product:${auth.session.userId}:${clientMessageId}` });
  if (!result.replayed) writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "chat.product.sent", objectType: "im_message", objectId: String(result.id), ip: requestIp(request), metadata: { buyerUserId, productId } });
  return NextResponse.json({ ok: true, id: result.id, replayed: result.replayed, product: snapshot },{ status: result.replayed ? 200 : 201 });
}
