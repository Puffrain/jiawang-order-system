import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";

type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) {
  const id = requestId(request);
  try {
    requirePipelineRole(request, "reviewer");
    const { jobId } = await context.params;
    const runtime = getPipelineRuntime();
    if (!runtime.store.getJob(jobId)) throw Object.assign(new Error("Job not found"), { code: "JOB_NOT_FOUND", class: "validation" });
    const parsedLast = Number(request.headers.get("last-event-id") || new URL(request.url).searchParams.get("after") || 0);
    let lastId = Number.isSafeInteger(parsedLast) && parsedLast >= 0 ? parsedLast : 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = () => {
          if (closed) return;
          const events = runtime.store.listEvents(jobId, lastId);
          for (const event of events) {
            lastId = event.id;
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
          }
        };
        push();
        timer = setInterval(push, 500);
        heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
        request.signal.addEventListener("abort", () => { closed = true; if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); try { controller.close(); } catch {} }, { once: true });
      },
      cancel() { closed = true; if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no", "x-request-id": id } });
  } catch (error) { return handlePipelineError(error, id); }
}
