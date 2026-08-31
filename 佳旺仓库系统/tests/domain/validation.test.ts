import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, RequestBodyLimitError } from '../../lib/validation';

test('bounded JSON parser rejects declared oversized bodies before parsing', async () => {
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '1000' },
    body: JSON.stringify({ ok: true }),
  });
  await assert.rejects(() => parseJson(request, 64), (error: unknown) => error instanceof RequestBodyLimitError);
});

test('bounded JSON parser enforces chunked byte limits and accepts valid UTF-8', async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode('{"na'), encoder.encode('me":"佳'), encoder.encode('旺"}')];
  const request = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    }),
    // Node requires duplex for a streaming request body.
    duplex: 'half',
  } as RequestInit);
  const value = await parseJson(request, 128);
  assert.deepEqual(value, { name: '佳旺' });

  const oversized = new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65)); controller.close(); },
    }),
    duplex: 'half',
  } as RequestInit);
  await assert.rejects(() => parseJson(oversized, 64), (error: unknown) => error instanceof RequestBodyLimitError);
});
