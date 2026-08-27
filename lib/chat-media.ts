import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGE_DIMENSION = 8192;
export const MAX_CHAT_IMAGE_PIXELS = 24_000_000;
const formats = {
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  png: { mime: "image/png", extension: "png" },
  webp: { mime: "image/webp", extension: "webp" },
  gif: { mime: "image/gif", extension: "gif" },
} as const;

export function chatImageRoot() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "data/uploads"), "chat-images");
}

export function detectChatImage(buffer: Buffer) {
  if (buffer.length >= 24 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) && buffer.subarray(-8,-4).toString() === "IEND") return { ...formats.png, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 14 && /^GIF8[79]a$/.test(buffer.subarray(0,6).toString()) && buffer.at(-1) === 0x3b) return { ...formats.gif, width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.length >= 30 && buffer.subarray(0,4).toString() === "RIFF" && buffer.subarray(8,12).toString() === "WEBP" && buffer.readUInt32LE(4) + 8 === buffer.length) {
    const kind = buffer.subarray(12,16).toString();
    if (kind === "VP8X") return { ...formats.webp, width: 1 + buffer.readUIntLE(24,3), height: 1 + buffer.readUIntLE(27,3) };
    if (kind === "VP8L" && buffer[20] === 0x2f) return { ...formats.webp, width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8), height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10) };
    if (kind === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) return { ...formats.webp, width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { ...formats.jpeg, width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return null;
}

export async function saveChatImage(file: File) {
  if (file.size < 1 || file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("图片大小须在 5MB 以内");
  const source = Buffer.from(await file.arrayBuffer());
  const detected = detectChatImage(source);
  if (!detected) throw new Error("图片内容无效，仅支持 JPEG、PNG、WebP 或 GIF");
  const decoder = sharp(source,{ failOn: "error", animated: true, limitInputPixels: MAX_CHAT_IMAGE_PIXELS });
  const metadata = await decoder.metadata().catch(() => null);
  if (!metadata || metadata.format !== detected.extension && !(metadata.format === "jpeg" && detected.extension === "jpg")) throw new Error("图片内容无效或已损坏");
  if ((metadata.pages || 1) > 120) throw new Error("GIF 动画帧数过多");
  const width = metadata.width || 0, height = metadata.pageHeight || metadata.height || 0;
  if (width < 1 || height < 1 || width > MAX_CHAT_IMAGE_DIMENSION || height > MAX_CHAT_IMAGE_DIMENSION || width * height > MAX_CHAT_IMAGE_PIXELS) throw new Error("图片尺寸过大");
  const buffer = await decoder.toFormat(metadata.format as "jpeg" | "png" | "webp" | "gif").toBuffer().catch(() => null);
  if (!buffer || buffer.length > MAX_CHAT_IMAGE_BYTES) throw new Error("图片处理后超过 5MB");
  const format = { ...detected, width, height };
  if (format.width < 1 || format.height < 1 || format.width > MAX_CHAT_IMAGE_DIMENSION || format.height > MAX_CHAT_IMAGE_DIMENSION || format.width * format.height > MAX_CHAT_IMAGE_PIXELS) throw new Error("图片尺寸过大");
  const root = chatImageRoot();
  await fs.promises.mkdir(root,{ recursive: true });
  const fileName = `${randomUUID()}.${format.extension}`;
  const fullPath = path.join(root,fileName);
  await fs.promises.writeFile(fullPath,buffer,{ flag: "wx" });
  return { fileName, fullPath, mimeType: format.mime, byteSize: buffer.length, width: format.width, height: format.height };
}

export function resolveChatImage(fileName: string) {
  const root = chatImageRoot();
  const fullPath = path.resolve(root,path.basename(fileName));
  if (path.dirname(fullPath) !== root) throw new Error("图片文件无效");
  return fullPath;
}
