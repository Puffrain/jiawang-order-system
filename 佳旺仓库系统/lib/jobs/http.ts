import { apiError, apiOk } from "../api";
import { handleApiError } from "../api";
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from "../security";
import { requireSessionUser } from "../session";
import type { Role } from "../contracts/platform";
import { PipelineError } from "../contracts/pipeline";
import { assertNotInMaintenance } from "../maintenance";
import type { AssetRecord } from "../contracts/pipeline";
import type { UploadSession } from "../contracts/pipeline";
import { parseJson, RequestBodyLimitError } from "../validation";

export function requestId(request: Request): string { return getRequestId(request); }

export function requirePipelineRole(request: Request, role: Role): { id: string; role: Role } {
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  // Browsers normally omit Origin on same-origin GET/HEAD (including
  // EventSource), so require it for mutations and validate it when a safe
  // request does provide one. Session/RBAC still protects every read.
  if (!safeMethod || request.headers.has("origin")) assertSameOrigin(request);
  if (!safeMethod) {
    assertCsrfToken(request);
    assertNotInMaintenance();
  }
  return requireSessionUser(request, role);
}

export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  let value: unknown;
  try {
    value = await parseJson(request, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw pipelineHttpError("BODY_LIMIT", "Request body is too large", 413);
    throw pipelineHttpError("INVALID_JSON", "Request body must be JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw pipelineHttpError("INVALID_JSON", "Request body must be an object", 400);
  return value as Record<string, unknown>;
}

export function pipelineHttpError(code: string, message: string, status = 400, details?: unknown): Error & { status: number; code: string; details?: unknown } {
  const error = new Error(message) as Error & { status: number; code: string; details?: unknown };
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function handlePipelineError(error: unknown, id: string) {
  if (error && typeof error === "object" && "status" in error && "code" in error && error instanceof Error) {
    const statusValue = (error as { status?: unknown }).status;
    const status = typeof statusValue === "number" ? statusValue : 500;
    if (status >= 400 && status <= 599) return handleApiError(error, id);
  }
  const candidate = error as Partial<PipelineError> & { status?: number };
  if (candidate?.code && candidate?.message) {
    const status = candidate.status || statusForPipelineClass(candidate.class);
    // Provider/worker errors may carry raw HTTP bodies, stack fragments or
    // local paths in `details`. Never return those on a 5xx response. For
    // client-actionable 4xx validation errors keep only a small JSON-safe
    // projection so an adapter cannot accidentally exfiltrate a secret.
    const details = status >= 500 ? undefined : safeDetails(candidate.details);
    return apiError(String(candidate.code), publicMessage(String(candidate.message), status), id, status, details);
  }
  return apiError("INTERNAL_ERROR", "Internal pipeline error", id, 500);
}

export function ok<T>(data: T, id: string, status = 200) { return apiOk(data, id, status); }

/**
 * Upload and asset records contain server-only filesystem paths.  Keep those
 * fields available to the worker/store, but never serialize them into a
 * browser/API response where they would disclose host layout or volume names.
 */
export function publicUpload(upload: UploadSession): Omit<UploadSession, "chunkDir" | "originalPath"> {
  const safe = { ...upload } as Partial<UploadSession>;
  delete safe.chunkDir;
  delete safe.originalPath;
  return safe as Omit<UploadSession, "chunkDir" | "originalPath">;
}

export function publicAsset(asset: AssetRecord): Omit<AssetRecord, "path"> {
  const safe = { ...asset } as Partial<AssetRecord>;
  delete safe.path;
  return safe as Omit<AssetRecord, "path">;
}

function statusForPipelineClass(value: string | undefined): number {
  if (value === "security") return 400;
  if (value === "budget") return 429;
  if (value === "provider") return 503;
  if (value === "image" || value === "validation") return 400;
  return 500;
}
function publicMessage(message: string, status: number): string {
  // Avoid leaking local paths/provider response bodies through API errors.
  if (status >= 500) return status === 503 ? "Vision provider unavailable" : "Internal pipeline error";
  return message.replace(/[A-Za-z]:\\[^\n]*|\/[^\n ]+/g, "[redacted path]").slice(0, 500);
}

function safeDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 4_096) return undefined;
    return JSON.parse(encoded);
  } catch {
    return undefined;
  }
}
