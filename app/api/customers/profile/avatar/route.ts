import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";

const root = path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), "data/uploads"), "profile-avatars");
function filePath(userId: string) { return path.join(root, `${userId}.webp`); }

export async function GET() {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  try {
    const data = await fs.readFile(filePath(auth.session.userId));
    return new NextResponse(data, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=300" } });
  } catch { return NextResponse.json({ error: "头像不存在" }, { status: 404 }); }
}

export async function POST(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get("avatar");
  if (!(file instanceof File) || file.size > 3 * 1024 * 1024 || !file.type.startsWith("image/")) return NextResponse.json({ error: "请选择不超过 3MB 的图片" }, { status: 400 });
  try {
    const output = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 16_000_000 }).rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(filePath(auth.session.userId), output, { mode: 0o600 });
    db.prepare("UPDATE customer_profile SET avatar_url=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?").run("/api/customers/profile/avatar", auth.session.userId);
    return NextResponse.json({ ok: true, avatarUrl: "/api/customers/profile/avatar" });
  } catch { return NextResponse.json({ error: "头像处理失败，请换一张图片" }, { status: 400 }); }
}
