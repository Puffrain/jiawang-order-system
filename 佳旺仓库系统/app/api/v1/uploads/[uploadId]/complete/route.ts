import { getPipelineRuntime } from "../../../../../../lib/jobs/runtime";
import { handlePipelineError, ok, publicAsset, publicUpload, readJson, requestId, requirePipelineRole } from "../../../../../../lib/jobs/http";
import { recordAudit } from "../../../../../../lib/audit";

type Context = { params: Promise<{ uploadId: string }> };
export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const { uploadId } = await context.params;
    let body: Record<string, unknown> = {};
    if (request.headers.get("content-length") !== "0" && request.headers.get("content-type")?.includes("json")) body = await readJson(request, 8 * 1024);
    const result = await getPipelineRuntime().uploads.complete(uploadId, { sha256: typeof body.sha256 === "string" ? body.sha256 : undefined });
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'upload.completed', resourceType: 'upload', resourceId: uploadId, metadata: { assetId: result.asset.id, sha256: result.asset.sha256, bytes: result.asset.bytes } });
    return ok({ upload: publicUpload(result.upload), asset: publicAsset(result.asset) }, id, 201);
  } catch (error) { return handlePipelineError(error, id); }
}
