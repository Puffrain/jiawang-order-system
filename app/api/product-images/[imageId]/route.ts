import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { currentSession } from "@/lib/session";
import { uploadRoot } from "@/lib/product-catalog";

export async function GET(_: Request, { params }: { params: Promise<{ imageId: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { imageId } = await params;
  const row = db.prepare(`SELECT i.storage_key storageKey,i.mime_type mimeType,p.status,p.archived_at archivedAt,p.permanently_hidden_at permanentlyHiddenAt
    FROM product_images i JOIN products p ON p.id=i.product_id WHERE i.id=?`).get(imageId) as { storageKey: string; mimeType: string; status: string; archivedAt: string | null; permanentlyHiddenAt: string | null } | undefined;
  if (!row || (session.role === "buyer" && (row.status !== "active" || row.archivedAt || row.permanentlyHiddenAt))) {
    return NextResponse.json({ error: "图片不存在" }, { status: 404 });
  }
  try {
    const bytes = await fs.readFile(path.join(uploadRoot, row.storageKey));
    return new NextResponse(bytes, { headers: { "Content-Type": row.mimeType, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
  } catch {
    return NextResponse.json({ error: "图片文件不存在" }, { status: 404 });
  }
}
