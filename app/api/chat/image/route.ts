import fs from "node:fs";
import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import db from "@/lib/db";
import { ownerUserId } from "@/lib/chat-events";
import { cleanText } from "@/lib/validation";
import { activeBuyer, insertChatMessage } from "@/lib/chat-messages";
import { saveChatImage } from "@/lib/chat-media";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { notifyCustomerMessage } from "@/lib/wecom";

export async function POST(request: Request) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const maxRequestBytes = 6 * 1024 * 1024;
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxRequestBytes) return NextResponse.json({ error: "图片不能超过 5MB" },{ status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (!reader) return NextResponse.json({ error: "图片数据无效" },{ status: 400 });
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxRequestBytes) { await reader.cancel(); return NextResponse.json({ error: "图片不能超过 5MB" },{ status: 413 }); }
    chunks.push(chunk.value);
  }
  const contentType = request.headers.get("content-type") || "";
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const form = await new Response(body,{ headers: { "Content-Type": contentType } }).formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "图片数据无效" },{ status: 400 });
  const file = form.get("image") || form.get("file");
  const clientMessageId = cleanText(form.get("clientMessageId"),100);
  const ownerId = auth.session.role === "owner" ? auth.session.userId : ownerUserId();
  const buyerUserId = auth.session.role === "buyer" ? auth.session.userId : cleanText(form.get("buyerUserId"),100);
  if (!(file instanceof File)) return NextResponse.json({ error: "请选择图片" },{ status: 400 });
  if (!clientMessageId) return NextResponse.json({ error: "消息编号缺失" },{ status: 400 });
  if (!ownerId || !buyerUserId || !activeBuyer(buyerUserId)) return NextResponse.json({ error: "客户不存在或已停用" },{ status: 404 });
  const eventKey = `image:${auth.session.userId}:${clientMessageId}`;
  let saved: Awaited<ReturnType<typeof saveChatImage>> | null = null;
  try {
    saved = await saveChatImage(file);
    const result = insertChatMessage({ fromUserId: auth.session.userId, toUserId: auth.session.role === "owner" ? buyerUserId : ownerId, buyerUserId, type: "image", content: "[图片]", eventKey, payload: { fileName: saved.fileName, mimeType: saved.mimeType, byteSize: saved.byteSize, width: saved.width, height: saved.height } });
    if (result.replayed) await fs.promises.unlink(saved.fullPath).catch(() => null);
    else {
      writeAudit({ actorUserId: auth.session.userId, actorRole: auth.session.role, action: "chat.image.sent", objectType: "im_message", objectId: String(result.id), ip: requestIp(request), metadata: { buyerUserId, mimeType: saved.mimeType, byteSize: saved.byteSize, width: saved.width, height: saved.height } });
      if (auth.session.role === "buyer") {
        const customer = db.prepare("SELECT u.display_name displayName,u.phone,p.shop_name shopName FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id WHERE u.id=?").get(buyerUserId) as { displayName: string | null; phone: string | null; shopName: string | null } | undefined;
        if (customer) void notifyCustomerMessage({ customer, messageType: "图片" });
      }
    }
    return NextResponse.json({ ok: true, id: result.id, replayed: result.replayed, mediaUrl: `/api/chat/media/${result.id}` },{ status: result.replayed ? 200 : 201 });
  } catch (error) {
    if (saved) await fs.promises.unlink(saved.fullPath).catch(() => null);
    return NextResponse.json({ error: error instanceof Error ? error.message : "图片发送失败" },{ status: 400 });
  }
}
