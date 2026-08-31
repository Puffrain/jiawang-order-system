import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PipelineStore } from '../../lib/jobs/store';
import { openAssetForRole, readAssetForRole } from '../../lib/pipeline/media';

test('media downloads stream large assets and bounded helper refuses buffering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-media-stream-'));
  const previousLimit = process.env.MAX_BUFFERED_MEDIA_BYTES;
  let store: PipelineStore | undefined;
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 9);
    const file = path.join(root, 'preview.webp');
    await fs.writeFile(file, bytes);
    store = new PipelineStore(path.join(root, 'state.json'));
    store.putAsset({
      id: 'preview-one', sha256: createHash('sha256').update(bytes).digest('hex'), path: file,
      filename: 'preview.webp', mimeType: 'image/webp', bytes: bytes.length,
      derivativeKind: 'preview', createdAt: new Date().toISOString(),
    });

    const opened = await openAssetForRole(store, 'preview-one', 'viewer', root);
    assert.equal((await new Response(opened.stream).arrayBuffer()).byteLength, bytes.length);
    process.env.MAX_BUFFERED_MEDIA_BYTES = '1024';
    await assert.rejects(readAssetForRole(store, 'preview-one', 'viewer', root), /流式下载|MEDIA_TOO_LARGE/i);
  } finally {
    if (previousLimit === undefined) delete process.env.MAX_BUFFERED_MEDIA_BYTES;
    else process.env.MAX_BUFFERED_MEDIA_BYTES = previousLimit;
    await store?.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
