import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../lib/audit";

type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const { jobId } = await context.params;
    const job = await getPipelineRuntime().runner.cancel(jobId);
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'import_job.cancelled', resourceType: 'import_job', resourceId: jobId, metadata: { status: job.status } });
    return ok({ job: publicJob(job) }, id);
  } catch (error) { return handlePipelineError(error, id); }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...value}=job;return value;}
