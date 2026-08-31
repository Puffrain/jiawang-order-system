import { getPipelineRuntime } from "../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, pipelineHttpError, requestId, requirePipelineRole } from "../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../lib/audit";

type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context) {
  const id = requestId(request);
  try {
    requirePipelineRole(request, "reviewer");
    const { jobId } = await context.params;
    const runtime = getPipelineRuntime();
    const job = runtime.store.getJob(jobId);
    if (!job) throw Object.assign(new Error("Job not found"), { code: "JOB_NOT_FOUND", class: "validation" });
    return ok({ job: publicJob(job), items: runtime.store.listItems(jobId), budget: runtime.ledger.getTask(job.budgetTaskId || `job:${jobId}`) }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

export async function DELETE(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const { jobId } = await context.params;
    const job = await getPipelineRuntime().runner.cancel(jobId);
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'import_job.cancelled', resourceType: 'import_job', resourceId: jobId, metadata: { status: job.status } });
    return ok({ job: publicJob(job) }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const { jobId } = await context.params;
    const runtime = getPipelineRuntime();
    const existing = runtime.store.getJob(jobId);
    if (!existing) throw pipelineHttpError("JOB_NOT_FOUND", "Job not found", 404);
    const inline = process.env.NODE_ENV !== "production" || process.env.RUN_INLINE_PIPELINE === "true";
    if (inline) {
      const job = await runtime.runner.run(jobId);
      recordAudit({ requestId: id, actorUserId: actor.id, action: 'import_job.processed', resourceType: 'import_job', resourceId: jobId, metadata: { status: job.status, execution: 'inline' } });
      return ok({ job: publicJob(job), items: runtime.store.listItems(jobId), execution: "inline" }, id);
    }
    if (existing.status !== "queued" && existing.status !== "running" && existing.status !== "paused") {
      throw pipelineHttpError("JOB_NOT_QUEUED", "Only queued, paused or running jobs can be submitted to the worker", 409, { status: existing.status });
    }
    // Production requests acknowledge the durable queue only.  ZIP expansion,
    // image preparation, and provider calls are owned by the worker process.
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'import_job.queued', resourceType: 'import_job', resourceId: jobId, metadata: { status: existing.status, execution: 'worker' } });
    return ok({ job: publicJob(existing), items: runtime.store.listItems(jobId), execution: "worker" }, id, 202);
  } catch (error) { return handlePipelineError(error, id); }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...value}=job;return value;}
