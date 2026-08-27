import { getPipelineRuntime } from "../../../../lib/jobs/runtime";
import { handlePipelineError, ok, publicUpload, readJson, requestId, requirePipelineRole } from "../../../../lib/jobs/http";
import { recordAudit } from "../../../../lib/audit";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request);
    if (typeof body.filename !== "string") throw Object.assign(new Error("filename is required"), { code: "FILENAME", class: "validation" });
    const upload = await getPipelineRuntime().uploads.create({
      filename: body.filename,
      expectedBytes: numberOrUndefined(body.expectedBytes),
      expectedChunks: numberOrUndefined(body.expectedChunks),
      chunkSize: numberOrUndefined(body.chunkSize),
      mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined,
    });
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'upload.created', resourceType: 'upload', resourceId: upload.id, metadata: { filename: upload.filename, expectedBytes: upload.expectedBytes, expectedChunks: upload.expectedChunks } });
    return ok({ upload: publicUpload(upload) }, id, 201);
  } catch (error) { return handlePipelineError(error, id); }
}

function numberOrUndefined(value: unknown): number | undefined { return value === undefined || value === null ? undefined : Number(value); }
