function randomUUIDSafe(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // Node and modern browsers both expose crypto.randomUUID; this fallback is
  // only for older test runners and is still unguessable enough for a request
  // correlation id (CSRF uses a longer token below).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function randomToken(bytes = 32): string {
  const values = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
  } else {
    const uuid = randomUUIDSafe().replaceAll('-', '');
    for (let index = 0; index < values.length; index += 1) {
      values[index] = uuid.charCodeAt(index % uuid.length) & 0xff;
    }
  }
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  // base64url without depending on Node's Buffer (proxy can run at the edge).
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

const requestBuckets = new Map<string, { startedAt: number; count: number }>();
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const CSRF_COOKIE = 'jw_csrf';

export class SecurityError extends Error {
  constructor(
    message: string,
    readonly status = 403,
    readonly code = 'SECURITY_ERROR'
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

export function getRequestId(request: Request): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUIDSafe();
}

export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const candidate = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim();
  if (!candidate || candidate.length > 128) return null;
  // Keep logs/audit records safe even when a proxy forwards malformed values.
  return /^[0-9a-fA-F:.[\]-]+$/.test(candidate) ? candidate : null;
}

export function getUserAgent(request: Request): string | null {
  const value = request.headers.get('user-agent');
  return value ? value.slice(0, 512) : null;
}

function expectedOrigin(request: Request): string | null {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      throw new SecurityError('APP_ORIGIN 配置无效', 500, 'SERVER_CONFIG_ERROR');
    }
  }
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host');
  // The Fetch Request URL is authoritative when Host is absent (common in
  // unit tests and edge runtimes). Never treat an unknown expected origin as
  // a wildcard, otherwise an arbitrary Origin would pass the check.
  if (!host) {
    try { return new URL(request.url).origin; } catch { return null; }
  }
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
  return `${proto}://${host}`;
}

/** Reject cross-site state-changing requests. Production deployments should
 * require an Origin header; only an explicit `REQUIRE_ORIGIN=false` opt-out
 * disables it for isolated local automation. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')?.trim();
  if (!origin) {
    if (process.env.REQUIRE_ORIGIN !== 'false') {
      throw new SecurityError('缺少 Origin', 403, 'ORIGIN_REQUIRED');
    }
    return;
  }
  if (origin === 'null') throw new SecurityError('不允许的 Origin', 403, 'ORIGIN_MISMATCH');
  let actual: string;
  try {
    actual = new URL(origin).origin;
  } catch {
    throw new SecurityError('不允许的 Origin', 403, 'ORIGIN_MISMATCH');
  }
  const expected = expectedOrigin(request);
  if (!expected || actual !== expected) {
    throw new SecurityError('不允许的 Origin', 403, 'ORIGIN_MISMATCH');
  }
}

/** Require JSON for endpoints that parse a JSON body.  Silently accepting a
 * missing content type makes content-sniffing and proxy confusion possible,
 * so callers must opt out explicitly (multipart/octet-stream routes do not
 * call this helper). */
export function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new SecurityError('仅支持 application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

/** Double-submit token check used in addition to Origin validation for browser
 * sessions. It is enabled by default; an explicit `REQUIRE_CSRF=false` is
 * required for isolated local automation. */
export function assertCsrfToken(request: Request): void {
  const cookieToken = parseCookies(request.headers.get('cookie')).get(CSRF_COOKIE);
  const headerToken = request.headers.get('x-csrf-token');
  if (!cookieToken && !headerToken) {
    if (process.env.REQUIRE_CSRF !== 'false') {
      throw new SecurityError('缺少 CSRF token', 403, 'CSRF_REQUIRED');
    }
    return;
  }
  // Origin validation remains the default browser defense and keeps existing
  // API clients interoperable. Set REQUIRE_CSRF=true when clients are ready to
  // send the double-submit header on every state-changing request.
  if (cookieToken && !headerToken && process.env.REQUIRE_CSRF === 'false') return;
  if (!cookieToken || !headerToken || cookieToken.length > 256 || !safeEqual(cookieToken, headerToken)) {
    throw new SecurityError('CSRF token 无效', 403, 'CSRF_INVALID');
  }
}

/** Convenience guard for route handlers that combine origin and CSRF checks. */
export function assertStateChangingRequest(request: Request, json = false): void {
  assertSameOrigin(request);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) assertCsrfToken(request);
  if (json) assertJsonContentType(request);
}

export function setCsrfCookie(response: Response, token = randomToken()): string {
  const nextResponse = response as Response & {
    cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
  };
  nextResponse.cookies?.set?.(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60
  });
  return token;
}

export function clearCsrfCookie(response: Response): void {
  const nextResponse = response as Response & {
    cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
  };
  nextResponse.cookies?.set?.(CSRF_COOKIE, '', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0)
  });
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Process-local guard for login/admin abuse. A reverse proxy should add a
 * distributed limit in front of multiple web replicas. */
export function checkRateLimit(key: string, limit = 10, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    pruneBuckets(now, windowMs);
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }
  current.count += 1;
  const allowed = current.count <= limit;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000));
  return {
    allowed,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: allowed ? 0 : retryAfterSeconds
  };
}

function pruneBuckets(now: number, windowMs: number): void {
  if (requestBuckets.size < 1000) return;
  for (const [key, bucket] of requestBuckets) {
    if (now - bucket.startedAt >= windowMs) requestBuckets.delete(key);
  }
}

export function resetRateLimits(): void {
  requestBuckets.clear();
}

export function parseCookies(header: string | null): Map<string, string> {
  const values = new Map<string, string>();
  if (!header) return values;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) {
      try {
        values.set(key, decodeURIComponent(value));
      } catch {
        // Ignore malformed cookie pairs rather than turning an invalid client
        // header into a 500 response.
      }
    }
  }
  return values;
}

export function securityHeaders(headers: Headers): Headers {
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-resource-policy', 'same-origin');
  return headers;
}

export function applyResponseHeaders(headers: Headers, requestId: string): void {
  headers.set('x-request-id', requestId);
  headers.set('cache-control', 'no-store');
  securityHeaders(headers);
}
