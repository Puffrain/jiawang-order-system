import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { cleanText } from "@/lib/validation";
import { activeBuyer, insertChatMessage, productSnapshot } from "@/lib/chat-messages";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { bulkPayloadHash } from "@/lib/chat-batch";

export async function POST(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const batchId = cleanText(body.batchId,100);
  const buyerUserIdSet = new Set<string>();
  if (Array.isArray(body.buyerUserIds)) {
    for (const value of body.buyerUserIds) {
      const buyerUserId = cleanText(value,100);
      if (typeof buyerUserId === "string" && buyerUserId) buyerUserIdSet.add(buyerUserId);
    }
  }
  const buyerUserIds = [...buyerUserIdSet].sort();
  const type = body.type === "product" ? "product" : body.type === "text" ? "text" : null;
  if (!batchId) return NextResponse.json({ error: "批次编号缺失" },{ status: 400 });
  if (!type) return NextResponse.json({ error: "批量消息类型无效" },{ status: 400 });
  if (buyerUserIds.length < 1 || buyerUserIds.length > 100) return NextResponse.json({ error: "每批请选择 1 至 100 位客户" },{ status: 400 });
  const invalidBuyer = buyerUserIds.find(buyerUserId => !activeBuyer(buyerUserId));
  if (invalidBuyer) return NextResponse.json({ error: "所选客户不存在或已停用", buyerUserId: invalidBuyer },{ status: 404 });
  const content = type === "text" ? cleanText(body.content,1000) : "";
  const productId = type === "product" ? cleanText(body.productId,100) : "";
  const snapshot = type === "product" ? productSnapshot(productId) : null;
  if (type === "text" && !content) return NextResponse.json({ error: "请输入消息内容" },{ status: 400 });
  if (type === "product" && !snapshot) return NextResponse.json({ error: "商品不存在或未上架" },{ status: 404 });
  const payloadHash = bulkPayloadHash({ buyerUserIds, type, content, productId });
  const existingBatch = db.prepare("SELECT owner_user_id ownerUserId,payload_hash payloadHash FROM im_message_batch WHERE batch_id=? LIMIT 1").get(batchId) as { ownerUserId: string | null; payloadHash: string | null } | undefined;
  if (existingBatch && (existingBatch.ownerUserId !== auth.session.userId || existingBatch.payloadHash !== payloadHash)) return NextResponse.json({ error: "批次编号已用于其他发送内容，请重新确认后发送" },{ status: 409 });

  let results: Array<{ buyerUserId: string; id: number | null; replayed: boolean }>;
  try { results = db.transaction(() => {
    const currentBatch = db.prepare("SELECT owner_user_id ownerUserId,payload_hash payloadHash FROM im_message_batch WHERE batch_id=? LIMIT 1").get(batchId) as { ownerUserId: string | null; payloadHash: string | null } | undefined;
    if (currentBatch && (currentBatch.ownerUserId !== auth.session.userId || currentBatch.payloadHash !== payloadHash)) throw new Error("BATCH_PAYLOAD_CONFLICT");
    return buyerUserIds.map(buyerUserId => {
    const reserved = db.prepare("INSERT OR IGNORE INTO im_message_batch(batch_id,buyer_user_id,owner_user_id,payload_hash) VALUES(?,?,?,?)").run(batchId,buyerUserId,auth.session.userId,payloadHash);
    if (!reserved.changes) {
      const existing = db.prepare("SELECT message_id messageId FROM im_message_batch WHERE batch_id=? AND buyer_user_id=?").get(batchId,buyerUserId) as { messageId: number | null };
      return { buyerUserId, id: existing.messageId, replayed: true };
    }
    const messageContent = type === "text" ? content : `[商品推荐] ${String(snapshot?.name)}`;
    const message = insertChatMessage({ fromUserId: auth.session.userId, toUserId: buyerUserId, buyerUserId, type, content: messageContent, payload: type === "product" ? { product: snapshot } : undefined, eventKey: `bulk:${batchId}:${buyerUserId}` });
    db.prepare("UPDATE im_message_batch SET message_id=? WHERE batch_id=? AND buyer_user_id=?").run(message.id,batchId,buyerUserId);
    return { buyerUserId, id: message.id, replayed: message.replayed };
    });
  })(); } catch (error) { if (error instanceof Error && error.message === "BATCH_PAYLOAD_CONFLICT") return NextResponse.json({ error: "批次编号已用于其他发送内容，请重新确认后发送" },{ status: 409 }); throw error; }
  const createdCount = results.filter(result => !result.replayed).length;
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: `chat.bulk.${type}.sent`, objectType: "im_message_batch", objectId: batchId, ip: requestIp(request), metadata: { buyerUserIds, recipientCount: buyerUserIds.length, createdCount, replayedCount: buyerUserIds.length-createdCount, productId: type === "product" ? productId : undefined } });
  return NextResponse.json({ ok: true, batchId, recipientCount: buyerUserIds.length, createdCount, replayedCount: buyerUserIds.length-createdCount, results },{ status: createdCount ? 201 : 200 });
}
