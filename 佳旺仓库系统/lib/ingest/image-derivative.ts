import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AssetRecord } from "../contracts/pipeline";
import { inspectImage, ImageInfo } from "./image-inspect";

export interface DerivativeOptions {
  kind?: "thumbnail" | "preview" | "normalized";
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  format?: "jpeg" | "png" | "webp";
  maxPixels?: number;
  maxBytes?: number;
}

export interface DerivativeResult {
  asset: AssetRecord;
  bytes: Uint8Array;
  usedSharp: boolean;
}

export class DerivativeError extends Error {
  readonly code: string;
  readonly class = "image" as const;
  readonly retryable = false;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DerivativeError";
    this.code = code;
  }
}

/**
 * Re-encode an image without metadata. `sharp` is used when installed (the
 * production package includes it); a conservative pure-byte fallback strips
 * EXIF/text chunks and preserves the source dimensions for minimal workers.
 */
export async function deriveImage(source: Uint8Array, sourceAsset: AssetRecord, outputRoot: string, options: DerivativeOptions = {}): Promise<DerivativeResult> {
  const input = Buffer.from(source);
  const info = inspectImage(input, { maxPixels: options.maxPixels, maxBytes: options.maxBytes });
  const kind = options.kind || "preview";
  const quality = options.quality ?? (kind === "thumbnail" ? 72 : 82);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new DerivativeError("DERIVATIVE_QUALITY", "quality must be an integer between 1 and 100");
  const maxWidth = options.maxWidth ?? (kind === "thumbnail" ? 640 : 2048);
  const maxHeight = options.maxHeight ?? (kind === "thumbnail" ? 640 : 2048);
  if (!Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth < 1 || maxHeight < 1) throw new DerivativeError("DERIVATIVE_DIMENSIONS", "maxWidth/maxHeight must be positive integers");
  const format = options.format || formatForMime(info.mimeType);
  const output = await reencodeWithSharp(input, format, quality, maxWidth, maxHeight).catch(() => undefined);
  const usedSharp = Boolean(output);
  const bytes = output || stripMetadata(input, info.mimeType);
  const effectiveFormat = output ? format : formatForMime(info.mimeType);
  if (options.maxBytes !== undefined && bytes.length > options.maxBytes) throw new DerivativeError("DERIVATIVE_BYTES", "Derived image exceeds byte limit");
  const derivedInfo = inspectImage(bytes, { maxPixels: options.maxPixels, maxBytes: options.maxBytes });
  const id = randomUUID();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const dir = path.resolve(outputRoot, "derivatives");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const ext = `.${effectiveFormat}`;
  const finalPath = path.join(dir, `${id}${ext}`);
  const tempPath = path.join(dir, `.${id}.tmp`);
  await fs.writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
  await fs.rename(tempPath, finalPath);
  const asset: AssetRecord = {
    id,
    sha256: digest,
    path: finalPath,
    filename: `${sourceAsset.id}-${kind}${ext}`,
    mimeType: `image/${effectiveFormat}`,
    bytes: bytes.length,
    width: derivedInfo.width,
    height: derivedInfo.height,
    pixels: derivedInfo.pixels,
    hasExif: false,
    sourceAssetId: sourceAsset.id,
    derivativeKind: kind,
    createdAt: new Date().toISOString(),
  };
  return { asset, bytes, usedSharp };
}

async function reencodeWithSharp(input: Buffer, format: "jpeg" | "png" | "webp", quality: number, maxWidth: number, maxHeight: number): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) throw new DerivativeError("SHARP_UNAVAILABLE", "sharp is not installed");
  let pipeline = sharp(input, { failOn: "error", limitInputPixels: false }).rotate().resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true });
  if (format === "jpeg") pipeline = pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
  else if (format === "png") pipeline = pipeline.png({ compressionLevel: 9, palette: true, quality });
  else pipeline = pipeline.webp({ quality, smartSubsample: true });
  // Deliberately omit `withMetadata`; sharp then removes EXIF, XMP, ICC and
  // orientation metadata while rotating according to the source orientation.
  return pipeline.toBuffer();
}

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: Record<string, unknown>): SharpPipeline;
  jpeg(options: Record<string, unknown>): SharpPipeline;
  png(options: Record<string, unknown>): SharpPipeline;
  webp(options: Record<string, unknown>): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}
type SharpModule = (input: Buffer, options?: Record<string, unknown>) => SharpPipeline;
let sharpPromise: Promise<SharpModule | undefined> | undefined;
async function loadSharp(): Promise<SharpModule | undefined> {
  if (!sharpPromise) {
    sharpPromise = (async () => {
      try {
        // Avoid a static module resolution requirement for lightweight test
        // environments that intentionally omit sharp.
        const imported: unknown = await Function("return import('sharp')")();
        if (typeof imported === "function") return imported as SharpModule;
        if (imported && typeof imported === "object" && "default" in imported && typeof imported.default === "function") return imported.default as SharpModule;
        return undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return sharpPromise;
}

function formatForMime(mime: ImageInfo["mimeType"]): "jpeg" | "png" | "webp" {
  return mime === "image/jpeg" ? "jpeg" : mime === "image/png" ? "png" : "webp";
}

function stripMetadata(input: Buffer, mime: ImageInfo["mimeType"]): Buffer {
  if (mime === "image/jpeg") return stripJpegMetadata(input);
  if (mime === "image/png") return stripPngMetadata(input);
  return stripWebpMetadata(input);
}

function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 2 || input.readUInt16BE(0) !== 0xffd8) return Buffer.from(input);
  const chunks: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  while (offset < input.length) {
    if (input[offset] !== 0xff) {
      chunks.push(input.subarray(offset));
      break;
    }
    const markerStart = offset;
    while (offset < input.length && input[offset] === 0xff) offset += 1;
    if (offset >= input.length) break;
    const marker = input[offset++];
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(input.subarray(markerStart));
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      chunks.push(input.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > input.length) {
      chunks.push(input.subarray(markerStart));
      break;
    }
    const length = input.readUInt16BE(offset);
    if (length < 2 || offset + length > input.length) {
      chunks.push(input.subarray(markerStart));
      break;
    }
    const segmentEnd = offset + length;
    // APP1 (EXIF/XMP), APP13 (IPTC), APP2 (ICC) and COM may contain source
    // metadata. Keep JFIF APP0 so ordinary decoders retain density info.
    const remove = marker === 0xfe || marker === 0xe1 || marker === 0xe2 || marker === 0xed;
    if (!remove) chunks.push(input.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  return Buffer.concat(chunks);
}

function stripPngMetadata(input: Buffer): Buffer {
  if (input.length < 8) return Buffer.from(input);
  const chunks: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > input.length) {
      chunks.push(input.subarray(offset));
      break;
    }
    const ancillary = (type.charCodeAt(0) & 0x20) !== 0;
    const remove = ancillary && type !== "PLTE";
    if (!remove) chunks.push(input.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(chunks);
}

function stripWebpMetadata(input: Buffer): Buffer {
  if (input.length < 12 || input.subarray(0, 4).toString("ascii") !== "RIFF") return Buffer.from(input);
  const chunks: Buffer[] = [Buffer.from(input.subarray(0, 12))];
  let offset = 12;
  while (offset + 8 <= input.length) {
    const type = input.subarray(offset, offset + 4).toString("ascii");
    const length = input.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > input.length) {
      chunks.push(input.subarray(offset));
      break;
    }
    if (type !== "EXIF" && type !== "XMP " && type !== "ICCP") chunks.push(input.subarray(offset, end));
    offset = end;
  }
  const result = Buffer.concat(chunks);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}
