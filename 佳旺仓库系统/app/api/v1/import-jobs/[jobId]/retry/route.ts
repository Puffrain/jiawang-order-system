import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../lib/audit";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request, 16 * 1024);
    const requestedItemId = body.itemId;
    if (requestedItemId !== undefined && (typeof requestedItemId !== "string" || !requestedItemId.trim())) {
      throw Object.assign(new Error("itemId must be a non-empty string"), { code: "ITEM_ID", class: "validation" });
    }
    const { jobId } = await context.params;
    const runtime = getPipelineRuntime();
    const itemId = typeof requestedItemId === "string" ? requestedItemId.trim() : undefined;
    const retried = itemId ? runtime.runner.retryItem(jobId, itemId) : runtime.runner.retry(jobId);
    const inline = process.env.NODE_ENV !== "production" || process.env.RUN_INLINE_PIPELINE === "true";
    const job = inline ? await runtime.runner.run(jobId) : retried;
    const item = itemId ? runtime.store.getItem(itemId) : undefined;
    recordAudit({ requestId: id, actorUserId: actor.id, action: itemId ? "import_item.retried" : "import_job.retried", resourceType: itemId ? "import_item" : "import_job", resourceId: itemId || jobId, metadata: { status: job.status, itemId, execution: inline ? "inline" : "worker" } });
    return ok({ job: publicJob(job), ...(itemId ? { item } : {}), scope: itemId ? "item" : "job", execution: inline ? "inline" : "worker" }, id);
  } catch (error) {
    return handlePipelineError(error, id);
  }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...value}=job;return value;}
