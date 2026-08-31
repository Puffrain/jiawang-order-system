import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { AssetRecord, PipelineError, UploadSession } from "../contracts/pipeline";
import { PipelineStore } from "../jobs/store";
import { inspectImage } from "./image-inspect";
import type { WriteLeaseContext, WriteLeaseOptions } from "../maintenance";

export interface UploadLimits {
  maxUploadBytes: number;
  maxChunkBytes: number;
  maxChunks: number;
  maxImagePixels: number;
  maxImageBytes: number;
}

export interface CreateUploadInput {
  filename: string;
  expectedBytes?: number;
  expectedChunks?: number;
  chunkSize?: number;
  mimeType?: string;
}

export interface CompleteUploadInput {
  sha256?: string;
}

/**
 * A chunk may be supplied as bytes (the normal service/test API) or as a
 * one-shot producer.  The HTTP route uses the producer form so the durable
 * write lease is acquired before the request body is drained; a backup or
 * restore therefore cannot begin in the middle of a large body upload.
 */
export type ChunkBodySource =
  | Uint8Array
  | Promise<Uint8Array>
  | (() => Uint8Array | Promise<Uint8Array>);

export type UploadWriteLeaseRunner = <T>(
  kind: string,
  operation: (context: WriteLeaseContext) => Promise<T> | T,
  options?: WriteLeaseOptions
) => Promise<T>;

export class UploadError extends Error {
  readonly code: string;
  readonly class = "validation" as const;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const DEFAULT_LIMITS: UploadLimits = {
  maxUploadBytes: 4 * 1024 * 1024 * 1024,
  maxChunkBytes: 16 * 1024 * 1024,
  maxChunks: 20_000,
  maxImagePixels: 120_000_000,
  maxImageBytes: 50 * 1024 * 1024,
};

export class ChunkedUploadService {
  readonly root: string;
  readonly limits: UploadLimits;
  constructor(
    readonly store: PipelineStore,
    root = process.env.PIPELINE_MEDIA_ROOT || path.join(process.cwd(), "data", "media"),
    limits: Partial<UploadLimits> = {},
    private readonly writeLeaseRunner?: UploadWriteLeaseRunner
  ) {
    this.root = path.resolve(root);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async create(input: CreateUploadInput): Promise<UploadSession> {
    return this.runWithWriteLease("upload.create", async (writeLease) => {
    const filename = sanitizeFilename(input.filename);
    validateInteger(input.expectedBytes, "expectedBytes", 0, this.limits.maxUploadBytes);
    validateInteger(input.expectedChunks, "expectedChunks", 1, this.limits.maxChunks);
    const chunkSize = input.chunkSize ?? Math.min(4 * 1024 * 1024, this.limits.maxChunkBytes);
    validateInteger(chunkSize, "chunkSize", 1, this.limits.maxChunkBytes);
    if (input.expectedBytes !== undefined && input.expectedChunks !== undefined) {
      const minimumChunks = Math.ceil(input.expectedBytes / chunkSize);
      if (minimumChunks !== input.expectedChunks) throw new UploadError("UPLOAD_SHAPE", "expectedChunks does not match expectedBytes/chunkSize");
    }
    await fs.mkdir(path.join(this.root, "chunks"), { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const chunkDir = path.join(this.root, "chunks", nonce);
    await fs.mkdir(chunkDir, { recursive: false, mode: 0o700 });
    try {
      writeLease?.renew();
      return this.store.createUpload({
        filename,
        expectedBytes: input.expectedBytes,
        expectedChunks: input.expectedChunks,
        chunkSize,
        mimeType: input.mimeType,
        chunkDir,
      });
    } catch (error) {
      await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    });
  }

  async putChunk(uploadId: string, index: number, input: ChunkBodySource, digestHex?: string): Promise<UploadSession> {
    return this.runWithWriteLease("upload.chunk", async (writeLease) => {
    validateInteger(index, "chunkIndex", 0, this.limits.maxChunks - 1);
    const upload = this.requireUpload(uploadId);
    if (upload.status === "completed") return upload;
    if (upload.status === "cancelled" || upload.status === "failed") throw new UploadError("UPLOAD_TERMINAL", `Upload is ${upload.status}`);
    if (upload.expectedChunks !== undefined && index >= upload.expectedChunks) throw new UploadError("CHUNK_INDEX", "Chunk index is outside expected range");
    // Resolve a producer only after the lease is held.  This is deliberately
    // one-shot: a consumed Request body cannot be replayed safely.
    const supplied = typeof input === "function" ? await input() : await input;
    if (!(supplied instanceof Uint8Array)) throw new UploadError("CHUNK_BODY", "Chunk body must be bytes");
    const data = Buffer.from(supplied);
    if (data.length === 0 || data.length > this.limits.maxChunkBytes || data.length > upload.chunkSize) throw new UploadError("CHUNK_SIZE", `Chunk must contain 1..${Math.min(this.limits.maxChunkBytes, upload.chunkSize)} bytes`);
    if (upload.expectedChunks !== undefined && index < upload.expectedChunks - 1 && data.length !== upload.chunkSize) throw new UploadError("CHUNK_SIZE", "Non-final chunk has the wrong size");
    const digest = createHash("sha256").update(data).digest("hex");
    if (digestHex && !safeDigestEqual(digest, digestHex)) throw new UploadError("CHUNK_DIGEST", "Chunk SHA-256 does not match");
    const chunkPath = path.join(upload.chunkDir, `${index}.part`);
    const chunkDirStat = await fs.lstat(upload.chunkDir).catch(() => undefined);
    if (!chunkDirStat?.isDirectory() || chunkDirStat.isSymbolicLink()) throw new UploadError("UPLOAD_PATH", "Upload chunk directory is not a regular directory");
    const realChunkDir = await fs.realpath(upload.chunkDir).catch(() => undefined);
    if (!realChunkDir || path.resolve(realChunkDir) !== path.resolve(upload.chunkDir)) throw new UploadError("UPLOAD_PATH", "Upload chunk directory is not canonical");
    writeLease?.assertActive();
    try {
      const handle = await fs.open(chunkPath, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existingStat = await fs.lstat(chunkPath).catch(() => undefined);
      if (!existingStat?.isFile() || existingStat.isSymbolicLink()) throw new UploadError("CHUNK_PATH", "Existing chunk is not a regular file");
      const existing = await fs.readFile(chunkPath);
      const existingDigest = createHash("sha256").update(existing).digest("hex");
      // Repeating the same chunk is idempotent; changing it is rejected.
      if (!safeDigestEqual(existingDigest, digest)) throw new UploadError("CHUNK_CONFLICT", "Chunk index was already uploaded with different bytes");
    }
    writeLease?.renew();
    if (!upload.receivedChunks.includes(index)) {
      upload.receivedChunks.push(index);
      upload.receivedChunks.sort((a, b) => a - b);
      upload.receivedBytes += data.length;
      upload.status = "uploading";
      if (upload.receivedBytes > this.limits.maxUploadBytes || (upload.expectedBytes !== undefined && upload.receivedBytes > upload.expectedBytes)) {
        upload.status = "failed";
        upload.error = pipelineUploadError("UPLOAD_BYTES_LIMIT", "Received bytes exceed declared/server limit");
        writeLease?.assertActive();
        this.store.putUpload(upload);
        throw new UploadError("UPLOAD_BYTES_LIMIT", upload.error.message);
      }
      this.store.putUpload(upload);
    }
    return this.requireUpload(uploadId);
    });
  }

  async complete(uploadId: string, input: CompleteUploadInput = {}): Promise<{ upload: UploadSession; asset: AssetRecord }> {
    return this.runWithWriteLease("upload.complete", async (writeLease) => {
    const upload = this.requireUpload(uploadId);
    if (upload.status === "completed" && upload.originalAssetId) {
      const asset = this.store.getAsset(upload.originalAssetId);
      if (!asset) throw new UploadError("ASSET_MISSING", "Completed upload references a missing asset", true);
      return { upload, asset };
    }
    if (upload.status === "cancelled" || upload.status === "failed") throw new UploadError("UPLOAD_TERMINAL", `Upload is ${upload.status}`);
    const count = upload.expectedChunks ?? (upload.receivedChunks.length ? upload.receivedChunks[upload.receivedChunks.length - 1] + 1 : 0);
    if (count < 1 || count > this.limits.maxChunks) throw new UploadError("CHUNKS_MISSING", "No complete chunk sequence was uploaded");
    for (let index = 0; index < count; index += 1) if (!upload.receivedChunks.includes(index)) throw new UploadError("CHUNKS_MISSING", `Chunk ${index} is missing`);
    if (upload.expectedChunks !== undefined && upload.receivedChunks.length !== upload.expectedChunks) throw new UploadError("CHUNKS_MISSING", "Chunk count does not match declaration");

    writeLease?.assertActive();
    const originals = path.join(this.root, "originals");
    await fs.mkdir(originals, { recursive: true, mode: 0o700 });
    const assetId = randomUUID();
    const extension = safeExtension(upload.filename || "upload.bin");
    const finalPath = path.join(originals, `${assetId}${extension}`);
    const tempPath = path.join(originals, `.${assetId}.assembling`);
    const hash = createHash("sha256");
    let total = 0;
    const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
    try {
      for (let index = 0; index < count; index += 1) {
        writeLease?.renew();
        const chunkPath = path.join(upload.chunkDir, `${index}.part`);
        const chunk = createReadStream(chunkPath);
        for await (const piece of chunk) {
          const buffer = Buffer.from(piece);
          total += buffer.length;
          if (total > this.limits.maxUploadBytes) throw new UploadError("UPLOAD_BYTES_LIMIT", "Assembled upload exceeds server limit");
          hash.update(buffer);
          if (!output.write(buffer)) await new Promise<void>((resolve) => output.once("drain", resolve));
        }
      }
      output.end();
      await finished(output);
      writeLease?.renew();
      if (upload.expectedBytes !== undefined && total !== upload.expectedBytes) throw new UploadError("UPLOAD_SIZE", `Assembled bytes ${total} do not match expected ${upload.expectedBytes}`);
      const sha256 = hash.digest("hex");
      if (input.sha256 && !safeDigestEqual(sha256, input.sha256)) throw new UploadError("UPLOAD_DIGEST", "Upload SHA-256 does not match");
      const head = await readHead(tempPath, Math.min(total, 1024 * 1024));
      const mimeType = sniffMime(head, upload.filename);
      if (mimeType.startsWith('image/') && total > this.limits.maxImageBytes) {
        throw new UploadError('IMAGE_BYTES_LIMIT', `Image exceeds ${this.limits.maxImageBytes} byte limit`);
      }
      let image: ReturnType<typeof inspectImage> | undefined;
      if (mimeType.startsWith("image/")) {
        const full = total <= head.length ? head : await fs.readFile(tempPath);
        image = inspectImage(full, { maxBytes: this.limits.maxImageBytes, maxPixels: this.limits.maxImagePixels });
      }
      writeLease?.renew();
      // Content-address originals before assigning a new UUID record. This
      // keeps repeated uploads idempotent while preserving each upload row.
      const existing = this.store.findAssetBySha256(sha256);
      if (existing && !existing.derivativeKind) {
        await fs.rm(tempPath, { force: true });
        upload.status = "completed";
        upload.originalAssetId = existing.id;
        upload.originalPath = existing.path;
        upload.sha256 = sha256;
        upload.mimeType = existing.mimeType;
        writeLease?.assertActive();
        const saved = this.store.putUpload(upload);
        await fs.rm(upload.chunkDir, { recursive: true, force: true }).catch(() => undefined);
        return { upload: saved, asset: existing };
      }
      writeLease?.renew();
      await fs.rename(tempPath, finalPath);
      // The rename awaits the filesystem. Re-check before publishing a DB
      // reference so a lease lost during that await fails closed and the
      // catch path removes the unreferenced final file.
      writeLease?.renew();
      let asset: AssetRecord = {
        id: assetId,
        sha256,
        path: finalPath,
        filename: upload.filename || `${assetId}${extension}`,
        mimeType,
        bytes: total,
        width: image?.width,
        height: image?.height,
        pixels: image?.pixels,
        hasExif: image?.hasExif,
        createdAt: new Date().toISOString(),
      };
      const persisted = this.store.putAsset(asset);
      // A backend may return an existing canonical record for a duplicate
      // digest. Use that record for the upload relationship and remove the
      // unreferenced newly named file.
      if (persisted.id !== asset.id) {
        await fs.rm(finalPath, { force: true });
        writeLease?.renew();
      }
      asset = persisted;
      upload.status = "completed";
      upload.originalAssetId = asset.id;
      upload.originalPath = asset.path;
      upload.sha256 = sha256;
      upload.mimeType = mimeType;
      writeLease?.assertActive();
      const saved = this.store.putUpload(upload);
      // Source bytes are already immutable; chunk cleanup is safe and avoids
      // retaining a second copy. A failed cleanup does not invalidate output.
      await fs.rm(upload.chunkDir, { recursive: true, force: true }).catch(() => undefined);
      return { upload: saved, asset };
    } catch (error) {
      output.destroy();
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      await fs.rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }
    });
  }

  async cancel(uploadId: string): Promise<UploadSession> {
    return this.runWithWriteLease("upload.cancel", async (writeLease) => {
    const upload = this.requireUpload(uploadId);
    if (upload.status === "completed" || upload.status === "cancelled") return upload;
    upload.status = "cancelled";
    writeLease?.renew();
    const saved = this.store.putUpload(upload);
    await fs.rm(upload.chunkDir, { recursive: true, force: true }).catch(() => undefined);
    return saved;
    });
  }

  private runWithWriteLease<T>(
    kind: string,
    operation: (context?: WriteLeaseContext) => Promise<T>
  ): Promise<T> {
    if (!this.writeLeaseRunner) return operation(undefined);
    return this.writeLeaseRunner(kind, operation, { heartbeat: true });
  }

  private requireUpload(id: string): UploadSession {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new UploadError("UPLOAD_ID", "Invalid upload id");
    const upload = this.store.getUpload(id);
    if (!upload) throw new UploadError("UPLOAD_NOT_FOUND", `Unknown upload ${id}`);
    const chunkRoot = path.resolve(this.root, "chunks") + path.sep;
    if (!path.resolve(upload.chunkDir).startsWith(chunkRoot)) throw new UploadError("UPLOAD_PATH", "Upload chunk path is outside media root");
    return upload;
  }
}

export function sanitizeFilename(input: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > 255) throw new UploadError("FILENAME", "Filename is empty or too long");
  const normalized = input.normalize("NFC").trim();
  if (/[\\/\u0000-\u001f\u007f:]/.test(normalized) || normalized === "." || normalized === "..") throw new UploadError("FILENAME", "Filename contains path/control/ADS characters");
  if (/[ .]$/.test(normalized) || isWindowsReservedName(normalized)) throw new UploadError("FILENAME", "Filename is not valid on the target filesystem");
  return normalized;
}

function isWindowsReservedName(value: string): boolean {
  const base = value.split('.')[0]?.toUpperCase();
  return Boolean(base && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base));
}

export function sniffMime(bytes: Uint8Array, filename = ""): string {
  const b = Buffer.from(bytes);
  if (b.length >= 4 && [0x04034b50, 0x02014b50, 0x06054b50].includes(b.readUInt32LE(0))) return "application/zip";
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".zip") throw new UploadError("MIME_MISMATCH", "File extension says ZIP but bytes are not ZIP");
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) throw new UploadError("MIME_MISMATCH", "Image extension does not match supported image bytes");
  throw new UploadError("UNSUPPORTED_MEDIA", "Only ZIP, JPEG, PNG and WebP bytes are accepted");
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return [".zip", ".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".bin";
}

function safeDigestEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expected)) throw new UploadError("DIGEST_FORMAT", "SHA-256 must be 64 hexadecimal characters");
  return timingSafeEqual(Buffer.from(actual.toLowerCase(), "hex"), Buffer.from(expected.toLowerCase(), "hex"));
}

function validateInteger(value: number | undefined, name: string, min: number, max: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new UploadError("INTEGER_RANGE", `${name} must be an integer between ${min} and ${max}`);
}

async function readHead(filePath: string, count: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const out = Buffer.alloc(count);
    const { bytesRead } = await handle.read(out, 0, count, 0);
    return out.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function pipelineUploadError(code: string, message: string): PipelineError {
  return { code, message, class: "validation", retryable: false };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
