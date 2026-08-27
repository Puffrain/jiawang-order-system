import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/session';
import { applyResponseHeaders, SecurityError } from '@/lib/security';
import { RequestBodyLimitError, ValidationError } from '@/lib/validation';
import type { ApiResponse } from '@/lib/contracts/platform';

export function apiOk<T>(data: T, requestId: string, status = 200): NextResponse<ApiResponse<T>> {
  const response = NextResponse.json<ApiResponse<T>>({ data, requestId }, { status });
  applyHeaders(response.headers, requestId);
  return response;
}

export function apiError(
  code: string,
  message: string,
  requestId: string,
  status = 400,
  details?: unknown
): NextResponse<ApiResponse<never>> {
  const response = NextResponse.json<ApiResponse<never>>(
    { error: { code, message, ...(details === undefined ? {} : { details }) }, requestId },
    { status }
  );
  applyHeaders(response.headers, requestId);
  return response;
}

export function handleApiError(error: unknown, requestId: string): NextResponse<ApiResponse<never>> {
  if (error instanceof RequestBodyLimitError) {
    return apiError(error.code, error.message, requestId, error.status);
  }
  if (error instanceof ValidationError) {
    return apiError(error.code, error.message, requestId, 400, error.fields);
  }
  if (error instanceof SecurityError || error instanceof AuthError) {
    return apiError(error.code, error.message, requestId, error.status);
  }
  // Domain services (media, maintenance, backup and pipeline adapters) use
  // the same small `{ code, status }` boundary. Preserve their deliberate
  // HTTP status without leaking filesystem paths, SQL or provider bodies.
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
    && typeof (error as Error & { status?: unknown }).status === 'number') {
    const typed = error as Error & { code: string; status: number };
    const status = Math.min(599, Math.max(400, Math.floor(typed.status)));
    const message = typed.code === 'MAINTENANCE' || typed.code === 'MAINTENANCE_BUSY' || typed.code === 'MAINTENANCE_OWNER'
      ? typed.message.slice(0, 500)
      : status >= 500 ? '服务器内部错误' : typed.message.slice(0, 500);
    return apiError(typed.code, message, requestId, status);
  }
  if (error instanceof Error && /already exists|unique constraint/i.test(error.message)) {
    return apiError('CONFLICT', '资源已存在', requestId, 409);
  }
  // Keep the client response generic, but retain a short correlation-safe
  // diagnostic in the server log so production failures can be located.
  if (error instanceof Error) {
    const safeMessage = error.message
      .replace(/(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/https?:\/\/[^\s]+/gi, '[url-redacted]')
      .slice(0, 500);
    console.error('[api] unhandled error', {
      requestId,
      name: error.name,
      message: safeMessage,
      code: typeof (error as Error & { code?: unknown }).code === 'string' ? (error as Error & { code: string }).code : undefined,
      status: typeof (error as Error & { status?: unknown }).status === 'number' ? (error as Error & { status: number }).status : undefined,
    });
  } else {
    console.error('[api] unhandled non-error value', { requestId, type: typeof error });
  }
  // Do not expose SQL, filesystem paths or provider credentials to clients.
  return apiError('INTERNAL_ERROR', '服务器内部错误', requestId, 500);
}

export function applyHeaders(headers: Headers, requestId: string): void {
  applyResponseHeaders(headers, requestId);
}
