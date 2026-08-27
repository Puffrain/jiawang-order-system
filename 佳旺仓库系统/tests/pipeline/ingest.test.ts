import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import { inspectImage } from "../../lib/ingest/image-inspect";
import { extractSafeZip, extractSafeZipFile, ZipSecurityError } from "../../lib/ingest/zip-safe";
import { PipelineStore } from "../../lib/jobs/store";
import { ChunkedUploadService } from "../../lib/ingest/chunked-upload";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("image inspection enforces actual pixel dimensions", () => {
  const info = inspectImage(PNG, { maxPixels: 1 });
  assert.equal(info.mimeType, "image/png");
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.throws(() => inspectImage(PNG, { maxPixels: 0 }), /pixels/i);
});

test("safe ZIP extracts an image and rejects zip-slip", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-zip-"));
  try {
    const normal = zip([{ name: "folder/one.png", data: PNG }]);
    const result = await extractSafeZip(normal, temp, { maxPixels: 10 });
    assert.equal(result.entries.length, 1);
    assert.equal(result.totalPixels, 1);
    const slip = zip([{ name: "../escape.png", data: PNG }]);
    await assert.rejects(extractSafeZip(slip, temp), (error: unknown) => error instanceof ZipSecurityError && error.code === "ZIP_PATH_TRAVERSAL");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("safe ZIP rejects encrypted, symlink, nested and high-ratio entries", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-zip-bad-"));
  try {
    await assert.rejects(extractSafeZip(zip([{ name: "x.png", data: PNG, flags: 1 }]), temp), /Encrypted/i);
    await assert.rejects(extractSafeZip(zip([{ name: "link.png", data: PNG, externalAttrs: 0xa000 << 16 }]), temp), /Symlink/i);
    await assert.rejects(extractSafeZip(zip([{ name: "inner.zip", data: zip([]) }]), temp), /Nested archive/i);
    const bomb = Buffer.alloc(10_000, 65);
    await assert.rejects(extractSafeZip(zip([{ name: "blob.bin", data: bomb, method: 8 }]), temp, { maxCompressionRatio: 5, allowNonImages: true }), /ratio/i);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("file-backed ZIP extraction streams entries, validates CRC, and cleans failed staging", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-zip-file-"));
  try {
    const archive = zip([{ name: "angles/front.png", data: PNG }, { name: "angles/back.png", data: PNG, method: 8 }]);
    const source = path.join(temp, "source.zip");
    await fs.writeFile(source, archive, { mode: 0o600 });
    const result = await extractSafeZipFile(source, temp, { maxPixels: 10 });
    assert.equal(result.entries.length, 2);
    assert.equal(result.totalBytes, PNG.length * 2);
    assert.deepEqual(result.entries.map((entry) => entry.name), ["angles/front.png", "angles/back.png"]);
    await fs.rm(result.root, { recursive: true, force: true });

    // The streaming yauzl path must reject a payload whose central-directory
    // CRC no longer matches, and remove its private extraction directory.
    const tampered = Buffer.from(archive);
    tampered[30 + Buffer.byteLength("angles/front.png", "utf8")] ^= 0xff;
    const badSource = path.join(temp, "tampered.zip");
    await fs.writeFile(badSource, tampered, { mode: 0o600 });
    await assert.rejects(extractSafeZipFile(badSource, temp, { maxPixels: 10 }), /CRC|corrupt|invalid/i);
    const leftovers = (await fs.readdir(temp)).filter((name) => name.startsWith("extract-"));
    assert.equal(leftovers.length, 0);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("chunk upload is resumable/idempotent and source digest is immutable", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-upload-"));
  let store: PipelineStore | undefined;
  try {
    store = new PipelineStore(path.join(temp, "state.json"));
    const service = new ChunkedUploadService(store, path.join(temp, "media"), { maxChunkBytes: 1024, maxUploadBytes: 2048 });
    const session = await service.create({ filename: "one.png", expectedBytes: PNG.length, expectedChunks: 1, chunkSize: PNG.length });
    await service.putChunk(session.id, 0, PNG);
    await service.putChunk(session.id, 0, PNG); // identical retry
    const completed = await service.complete(session.id);
    assert.equal(completed.asset.sha256, completed.upload.sha256);
    assert.equal(completed.asset.bytes, PNG.length);
    const retry = await service.complete(session.id);
    assert.equal(retry.asset.id, completed.asset.id);
    assert.throws(() => store!.putAsset({ ...completed.asset, sha256: "0".repeat(64) }), /cannot be changed/i);
  } finally { await store?.flush().catch(() => undefined); await fs.rm(temp, { recursive: true, force: true }); }
});

interface ZipInput { name: string; data: Buffer; flags?: number; method?: 0 | 8; externalAttrs?: number }
function zip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const flags = (entry.flags || 0) | 0x800;
    const method = entry.method || 0;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.externalAttrs || 0) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
