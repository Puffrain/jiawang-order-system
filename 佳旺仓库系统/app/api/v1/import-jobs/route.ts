import { getPipelineRuntime } from "../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../lib/jobs/http";
import { recordAudit } from "../../../../lib/audit";
import { encryptedActiveJobSnapshot } from "../../../../lib/ai-profiles";
import { completeIdempotency, getIdempotent, hashRequest, normalizeIdempotencyKey, releaseIdempotency, reserveIdempotency } from "../../../../lib/idempotency";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    // Import filenames, failures and token/cost data are operational records,
    // not part of the published catalogue exposed to read-only accounts.
    requirePipelineRole(request, "reviewer");
    const limit = Number(new URL(request.url).searchParams.get("limit") || 100);
    return ok({ jobs: getPipelineRuntime().store.listJobs(limit).map(publicJob) }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  let idempotency: { key: string; hash: string; actorId: string } | undefined;
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request);
    if (typeof body.uploadId !== "string") throw Object.assign(new Error("uploadId is required"), { code: "UPLOAD_ID", class: "validation" });
    const suppliedKey = request.headers.get("idempotency-key");
    if (suppliedKey != null) {
      const key = normalizeIdempotencyKey(suppliedKey);
      if (!key) throw Object.assign(new Error("Idempotency-Key 格式无效"), { code: "IDEMPOTENCY_KEY", class: "validation" });
      const hash = hashRequest(body);
      const hit = getIdempotent("import-job.create", key, actor.id, hash);
      if (hit) return ok(hit.response, id, hit.statusCode);
      reserveIdempotency("import-job.create", key, actor.id, hash);
      idempotency = { key, hash, actorId: actor.id };
    }
    const active = encryptedActiveJobSnapshot();
    const provider = active?.provider || (body.provider === undefined ? undefined : String(body.provider));
    const inline = process.env.NODE_ENV !== "production" || process.env.RUN_INLINE_PIPELINE === "true";
    const job = await getPipelineRuntime().runner.createFromUpload(body.uploadId, { provider, aiProfileId: active?.profileId, aiProfileRevisionId: active?.revisionId, aiProfileName: active?.profileName, aiModel: active?.model, aiProfileRevision: active?.revision, aiVersionFingerprint: active?.versionFingerprint, aiConfigSnapshot: active?.snapshot, deferPreparation: !inline, zipLimits: {
      // A caller may request stricter limits, never raise deployment ceilings.
      maxPixels: boundedLimit(body.maxPixels, 'MAX_IMAGE_PIXELS', 40_000_000),
      maxEntries: boundedLimit(body.maxEntries, 'MAX_ZIP_ENTRIES', 10_000),
      maxEntryBytes: boundedLimit(body.maxEntryBytes, 'MAX_IMAGE_BYTES', 50 * 1024 * 1024),
      maxTotalBytes: boundedLimit(body.maxTotalBytes, 'MAX_EXTRACTED_BYTES', 12 * 1024 * 1024 * 1024),
    } });
    const payload = { job: publicJob(job), items: getPipelineRuntime().store.listItems(job.id) };
    const status = inline ? 201 : 202;
    if (idempotency) completeIdempotency("import-job.create", idempotency.key, idempotency.actorId, idempotency.hash, payload, status);
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'import_job.created', resourceType: 'import_job', resourceId: job.id, metadata: { uploadId: body.uploadId, provider: job.provider, status: job.status, execution: inline ? 'inline' : 'worker' } });
    return ok(payload, id, status);
  } catch (error) {
    if (idempotency) releaseIdempotency("import-job.create", idempotency.key, idempotency.actorId, idempotency.hash);
    return handlePipelineError(error, id);
  }
}
function publicJob<T extends {aiConfigSnapshot?:string}>(job:T):Omit<T,'aiConfigSnapshot'>{const {aiConfigSnapshot:_,...publicValue}=job;return publicValue;}
function numberOrUndefined(value: unknown): number | undefined { return value === undefined || value === null ? undefined : Number(value); }
function boundedLimit(value: unknown, envName: string, fallback: number): number | undefined {
  const requested = numberOrUndefined(value);
  if (requested === undefined) return undefined;
  const configured = numberOrUndefined(process.env[envName]) || fallback;
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, configured) : undefined;
}
