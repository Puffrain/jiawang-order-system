import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamRestoreMultipart } from '../../lib/backup/multipart';

function requestFor(body: Buffer, boundary: string, chunkSize = body.length): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < body.length; offset += chunkSize) controller.enqueue(body.subarray(offset, Math.min(body.length, offset + chunkSize)));
      controller.close();
    },
  });
  return new Request('http://warehouse.test/api/v1/admin/backups/restore', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: stream,
    // Node's Request implementation requires this for a streaming request.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function multipart(boundary: string, file: Buffer, passphrase: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n${passphrase}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.jwbackup"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test('restore multipart parser streams split boundaries and strips server paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-multipart-'));
  const target = path.join(root, 'incoming.jwbackup');
  try {
    const boundary = 'jw-boundary-123';
    const payload = Buffer.from('encrypted bytes\0\xff');
    const result = await streamRestoreMultipart(requestFor(multipart(boundary, payload, 'correct horse battery staple'), boundary, 3), target, 1024);
    assert.equal(result.passphrase, 'correct horse battery staple');
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(await fs.readFile(target), payload);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('restore multipart parser removes an over-limit staging file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-multipart-limit-'));
  const target = path.join(root, 'incoming.jwbackup');
  try {
    const boundary = 'jw-limit';
    await assert.rejects(
      streamRestoreMultipart(requestFor(multipart(boundary, Buffer.alloc(32, 7), 'correct horse battery staple'), boundary, 5), target, 8),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'RESTORE_SIZE'),
    );
    await assert.rejects(fs.stat(target));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
