import { getPipelineRuntime } from "../../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, requestId, requirePipelineRole } from "../../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../../lib/audit";

type Context = { params: Promise<{ uploadId: string; chunkIndex: string }> };
export async function PUT(request: Request, context: Context) { return receive(request, context); }
export async function POST(request: Request, context: Context) { return receive(request, context); }
async function receive(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const { uploadId, chunkIndex } = await context.params;
    const maxBytes = 16 * 1024 * 1024;
    const length = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Chunk is too large"), { code: "CHUNK_SIZE", class: "validation" });
    // Pass a one-shot producer into the service.  In SQLite mode the service
    // acquires its durable write lease before invoking it, so maintenance
    // cannot snapshot between draining the request body and persisting the
    // chunk.  The producer is still bounded even when Content-Length is
    // absent (for example, a chunked HTTP transfer).
    const upload = await getPipelineRuntime().uploads.putChunk(
      uploadId,
      Number(chunkIndex),
      () => readLimitedBody(request, maxBytes),
      request.headers.get("x-chunk-sha256") || undefined,
    );
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'upload.chunk_received', resourceType: 'upload', resourceId: upload.id, metadata: { chunkIndex: Number(chunkIndex), receivedBytes: upload.receivedBytes, receivedChunks: upload.receivedChunks.length } });
    return ok({ uploadId: upload.id, receivedChunks: upload.receivedChunks, receivedBytes: upload.receivedBytes }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body limit').catch(() => undefined);
        throw Object.assign(new Error('Chunk is too large'), { code: 'CHUNK_SIZE', class: 'validation' });
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
