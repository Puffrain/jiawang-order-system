import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetRecord } from './contracts/pipeline';
import { deriveImage } from './ingest/image-derivative';
import { getPipelineRuntime } from './jobs/runtime';
import { withWriteLease } from './maintenance';
import { openAssetForRole } from './pipeline/media';

const MAX_MANUAL_IMAGE_BYTES = 50 * 1024 * 1024;

export async function prepareManualProductAsset(sourceAssetId: string): Promise<AssetRecord> {
  if (!/^[0-9a-f-]{36}$/i.test(sourceAssetId)) throw mediaError('ASSET_ID', 'Invalid asset id');
  return withWriteLease('catalog.manual_asset.prepare', async (lease) => {
    const runtime = getPipelineRuntime();
    const source = runtime.store.getAsset(sourceAssetId);
    if (!source) throw mediaError('ASSET_NOT_FOUND', 'Uploaded image does not exist', 404);
    if (!source.mimeType.startsWith('image/')) throw mediaError('ASSET_TYPE', 'Product assets must be JPEG, PNG, or WebP images');
    if (source.bytes <= 0 || source.bytes > MAX_MANUAL_IMAGE_BYTES) throw mediaError('ASSET_SIZE', 'A product image cannot exceed 50 MB');
    if (source.derivativeKind) return source;

    const existing = Object.values(runtime.store.snapshot.assets).find((asset) => asset.sourceAssetId === source.id && asset.derivativeKind === 'normalized');
    if (existing) return existing;

    lease.assertActive();
    const opened = await openAssetForRole(runtime.store, source.id, 'reviewer');
    const bytes = new Uint8Array(await new Response(opened.stream).arrayBuffer());
    const result = await deriveImage(bytes, source, process.env.PIPELINE_MEDIA_ROOT || path.join(process.cwd(), 'data', 'media'), {
      kind: 'normalized',
      maxWidth: 2_048,
      maxHeight: 2_048,
      quality: 84,
      format: 'webp',
      maxBytes: MAX_MANUAL_IMAGE_BYTES,
      maxPixels: positiveLimit(process.env.MAX_IMAGE_PIXELS, 40_000_000),
    });
    try {
      lease.renew();
      const persisted = runtime.store.putAsset(result.asset);
      // Ensure file-backed stores are durable before the API reports success.
      // SQLite-backed stores persist synchronously, so this is a no-op there.
      await runtime.store.flush();
      if (persisted.id !== result.asset.id) await fs.rm(result.asset.path, { force: true }).catch(() => undefined);
      return persisted;
    } catch (error) {
      await fs.rm(result.asset.path, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mediaError(code: string, message: string, status = 400): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}
