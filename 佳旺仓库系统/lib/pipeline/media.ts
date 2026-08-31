import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Role } from "../contracts/platform";
import type { AssetRecord } from "../contracts/pipeline";
import { PipelineStore } from "../jobs/store";

export class MediaAccessError extends Error {
  readonly code: string;
  readonly status: number;
  readonly class = "security" as const;
  constructor(code: string, message: string, status = 403) { super(message); this.name = "MediaAccessError"; this.code = code; this.status = status; }
}

export interface MediaResult {
  asset: AssetRecord;
  bytes: Buffer;
}

export interface MediaStreamResult {
  asset: AssetRecord;
  stream: ReadableStream<Uint8Array>;
}

/** Read only server-generated media paths after role and symlink checks. */
export async function readAssetForRole(store: PipelineStore, assetId: string, role: Role, mediaRoot = process.env.PIPELINE_MEDIA_ROOT || path.join(process.cwd(), "data", "media")): Promise<MediaResult> {
  const opened = await openAssetForRole(store, assetId, role, mediaRoot);
  const maxBuffered = parseLimit(process.env.MAX_BUFFERED_MEDIA_BYTES, 64 * 1024 * 1024);
  if (opened.asset.bytes > maxBuffered) throw new MediaAccessError("MEDIA_TOO_LARGE", "媒体文件需要使用流式下载", 413);
  const bytes = Buffer.from(await new Response(opened.stream).arrayBuffer());
  return { asset: opened.asset, bytes };
}

/** Open a validated media stream without buffering the complete file in the
 * web process. A hashing transform verifies the immutable SHA-256 while bytes
 * are sent; a mismatch terminates the stream and never returns corrupt data as
 * a successful complete response. */
export async function openAssetForRole(store: PipelineStore, assetId: string, role: Role, mediaRoot = process.env.PIPELINE_MEDIA_ROOT || path.join(process.cwd(), "data", "media")): Promise<MediaStreamResult> {
  let asset = store.getAsset(assetId);
  if (!asset) throw new MediaAccessError("MEDIA_NOT_FOUND", "Media asset not found", 404);
  if (role === "viewer" && !asset.derivativeKind) {
    // Published product rows may retain the immutable original as their
    // primary asset. A read-only account can see a derived preview linked by
    // sourceAssetId, but never receives the original bytes.
    const derivative = Object.values(store.snapshot.assets).find((candidate) => candidate.sourceAssetId === asset?.id && Boolean(candidate.derivativeKind));
    if (!derivative) throw new MediaAccessError("MEDIA_FORBIDDEN", "Original media requires reviewer access", 403);
    asset = derivative;
  }
  if (/^(?:https?|file|data):/i.test(asset.path)) throw new MediaAccessError("MEDIA_PATH", "Media path is not local", 400);
  const root = path.resolve(mediaRoot);
  const absolute = path.resolve(asset.path);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new MediaAccessError("MEDIA_PATH", "Media path is outside the media root", 403);
  const stat = await fs.lstat(absolute).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new MediaAccessError("MEDIA_NOT_FOUND", "Media file is unavailable", 404);
  const real = await fs.realpath(absolute).catch(() => undefined);
  if (!real || real !== absolute) throw new MediaAccessError("MEDIA_PATH", "Media path is not a canonical local file", 403);
  if (stat.size !== asset.bytes) throw new MediaAccessError("MEDIA_INTEGRITY", "Media byte count does not match its immutable record", 409);
  const source = fsSync.createReadStream(real, { highWaterMark: 256 * 1024 });
  const hash = createHash("sha256");
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { hash.update(chunk); callback(null, chunk); } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try {
        const digest = hash.digest("hex");
        if (digest !== asset.sha256) callback(new MediaAccessError("MEDIA_INTEGRITY", "Media digest does not match its immutable record", 409));
        else callback();
      } catch (error) { callback(error as Error); }
    },
  });
  source.on("error", (error) => verifier.destroy(error));
  source.pipe(verifier);
  return { asset, stream: Readable.toWeb(verifier) as ReadableStream<Uint8Array> };
}

export function safeDownloadName(filename: string): string {
  const base = path.basename(filename).replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim();
  return (base || "asset").slice(0, 180);
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
