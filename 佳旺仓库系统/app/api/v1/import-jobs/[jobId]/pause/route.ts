import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../lib/audit";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request, 16 * 1024);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
    const { jobId } = await context.params;
    const job = getPipelineRuntime().runner.pause(jobId, reason);
    recordAudit({ requestId: id, actorUserId: actor.id, action: "import_job.paused", resourceType: "import_job", resourceId: jobId, metadata: { status: job.status, reason } });
    return ok({ job: publicJob(job) }, id);
  } catch (error) {
    return handlePipelineError(error, id);
  }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...value}=job;return value;}
