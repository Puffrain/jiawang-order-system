import { apiError, apiOk, handleApiError } from '@/lib/api';
import { authenticateCredentials, ensureBootstrapAdmin } from '@/lib/auth';
import { recordAudit } from '@/lib/audit';
import {
  assertJsonContentType,
  setCsrfCookie,
  assertSameOrigin,
  checkRateLimit,
  getClientIp,
  getRequestId,
  getUserAgent
} from '@/lib/security';
import { createSession, sessionContextFromRequest, setSessionCookie } from '@/lib/session';
import { parseJson, parseLoginInput } from '@/lib/validation';
import { assertNotInMaintenance } from '@/lib/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const ip = getClientIp(request) ?? 'unknown';
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    // Login creates a durable session and bootstrap may create a user; both
    // are fenced while backup/restore maintenance holds the database.
    assertNotInMaintenance();
    const limit = checkRateLimit(`login:${ip}`, 10, 60_000);
    if (!limit.allowed) {
      const response = apiError('RATE_LIMITED', '请求过于频繁，请稍后重试', requestId, 429);
      response.headers.set('retry-after', String(limit.retryAfterSeconds));
      return response;
    }

    // Creating the first admin is opt-in and only happens when both bootstrap
    // environment variables are present. No credential is logged or returned.
    ensureBootstrapAdmin();
    const input = parseLoginInput(await parseJson(request));
    const user = authenticateCredentials(input.username, input.password);
    if (!user) {
      recordAudit({
        requestId,
        action: 'auth.login_failed',
        resourceType: 'user',
        metadata: { username: input.username, ip }
      });
      return apiError('INVALID_CREDENTIALS', '用户名或密码错误', requestId, 401);
    }

    const session = createSession(user.id, sessionContextFromRequest(request));
    recordAudit({
      requestId,
      actorUserId: user.id,
      action: 'auth.login_succeeded',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { ip, userAgent: getUserAgent(request) }
    });
    const response = apiOk({ user }, requestId);
    setSessionCookie(response, session.token, session.expiresAt);
    setCsrfCookie(response);
    return response;
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
