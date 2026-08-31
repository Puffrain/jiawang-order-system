import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../lib/audit";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    await readJson(request, 16 * 1024);
    const { jobId } = await context.params;
    const runtime = getPipelineRuntime();
    const resumed = runtime.runner.resume(jobId);
    const inline = process.env.NODE_ENV !== "production" || process.env.RUN_INLINE_PIPELINE === "true";
    const job = inline ? await runtime.runner.run(jobId) : resumed;
    recordAudit({ requestId: id, actorUserId: actor.id, action: "import_job.resumed", resourceType: "import_job", resourceId: jobId, metadata: { status: job.status, execution: inline ? "inline" : "worker" } });
    return ok({ job: publicJob(job), execution: inline ? "inline" : "worker" }, id);
  } catch (error) {
    return handlePipelineError(error, id);
  }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...value}=job;return value;}
