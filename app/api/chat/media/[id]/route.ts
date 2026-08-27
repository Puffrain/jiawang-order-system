import fs from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { resolveChatImage } from "@/lib/chat-media";

export async function GET(_: Request,{ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const { id } = await params;
  const message = db.prepare("SELECT from_user_id fromUserId,to_user_id toUserId,payload_json payloadJson FROM im_message WHERE id=? AND msg_type='image'").get(Number(id)) as { fromUserId: string; toUserId: string; payloadJson: string } | undefined;
  if (!message) return NextResponse.json({ error: "图片不存在" },{ status: 404 });
  if (message.fromUserId !== auth.session.userId && message.toUserId !== auth.session.userId) return NextResponse.json({ error: "无权读取此图片" },{ status: 403 });
  let payload: { fileName?: string; mimeType?: string };
  try { payload = JSON.parse(message.payloadJson); } catch { return NextResponse.json({ error: "图片记录损坏" },{ status: 410 }); }
  if (!payload.fileName) return NextResponse.json({ error: "图片文件缺失" },{ status: 410 });
  const filePath = resolveChatImage(payload.fileName);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return NextResponse.json({ error: "图片文件不存在" },{ status: 404 });
  const stream = fs.createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream,{ headers: { "Content-Type": payload.mimeType || "application/octet-stream", "Content-Length": String(stat.size), "Cache-Control": "private, max-age=3600", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" } });
}
