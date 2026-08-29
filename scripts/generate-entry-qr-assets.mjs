import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const logoPath = process.argv[2];
if (!logoPath) throw new Error("Usage: node scripts/generate-entry-qr-assets.mjs <portrait.png>");

const outputDir = path.join(root, "public", "qr");
const entries = [
  { name: "customer-login", title: "客户登录", url: "https://kunshanjiawang.cn/buyer/login" },
  { name: "merchant-login", title: "商家后台", url: "https://kunshanjiawang.cn/admin/login" },
  { name: "courier-login", title: "配送员登录", url: "https://kunshanjiawang.cn/courier/login" },
  { name: "warehouse-login", title: "仓库系统", url: "https://kunshanjiawang.cn/warehouse/login" },
];

const escapeXml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const textSvg = (title, url) => Buffer.from(`
  <svg width="1200" height="250" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="250" fill="#ffffff"/>
    <text x="600" y="92" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, Arial, sans-serif" font-size="54" font-weight="700" fill="#172033">${escapeXml(title)}</text>
    <text x="600" y="160" text-anchor="middle" font-family="Arial, sans-serif" font-size="31" fill="#556070">${escapeXml(url.replace("https://", ""))}</text>
  </svg>`);

await fs.mkdir(outputDir, { recursive: true });
const portrait = await sharp(logoPath).resize(122, 122, { fit: "cover" }).png().toBuffer();
const logo = await sharp({
  create: { width: 172, height: 172, channels: 4, background: "#ffffff" },
})
  .composite([
    { input: Buffer.from('<svg width="172" height="172" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="166" height="166" rx="32" fill="white" stroke="#d7deea" stroke-width="6"/></svg>') },
    { input: portrait, top: 25, left: 25 },
  ])
  .png()
  .toBuffer();

for (const entry of entries) {
  const request = new URL("https://api.qrserver.com/v1/create-qr-code/");
  request.searchParams.set("size", "1024x1024");
  request.searchParams.set("format", "png");
  request.searchParams.set("ecc", "H");
  request.searchParams.set("margin", "18");
  request.searchParams.set("data", entry.url);
  const response = await fetch(request);
  if (!response.ok) throw new Error(`QR provider failed for ${entry.name}: ${response.status}`);
  // The provider may return a smaller raster despite the requested size.
  // Use nearest-neighbor scaling so QR modules remain crisp and square.
  const qr = await sharp(Buffer.from(await response.arrayBuffer()))
    .resize(1024, 1024, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  const file = path.join(outputDir, `${entry.name}-qr.png`);
  await sharp({
    create: { width: 1200, height: 1450, channels: 4, background: "#ffffff" },
  })
    .composite([
      { input: qr, top: 60, left: 88 },
      { input: logo, top: 486, left: 514 },
      { input: textSvg(entry.title, entry.url), top: 1160, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`${entry.name}: ${entry.url} -> ${path.relative(root, file)}`);
}
