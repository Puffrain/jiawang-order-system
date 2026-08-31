import { apiOk, handleApiError } from '@/lib/api';
import { changePassword } from '@/lib/auth';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { createSession, getSessionUser, sessionContextFromRequest, setSessionCookie } from '@/lib/session';
import { assertNotInMaintenance } from '@/lib/maintenance';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    assertNotInMaintenance();
    const actor = getSessionUser(request);
    if (!actor) return handleApiError(Object.assign(new Error('请先登录'), { status: 401, code: 'UNAUTHENTICATED' }), requestId);
    const parsed = await parseJson(request, 16 * 1024);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return handleApiError(Object.assign(new Error('Request body must be a JSON object'), { status: 400, code: 'INVALID_JSON' }), requestId);
    }
    const body = parsed as Record<string, unknown>;
    const currentPassword = body.currentPassword;
    const nextPassword = body.newPassword;
    if (typeof currentPassword !== 'string' || typeof nextPassword !== 'string' || nextPassword.length < 8 || nextPassword.length > 256) {
      return handleApiError(Object.assign(new Error('密码长度必须在 8-256 个字符之间'), { status: 400, code: 'INVALID_PASSWORD' }), requestId);
    }
    const user = changePassword(actor.id, currentPassword, nextPassword);
    // Rotation revokes the old session; issue a fresh one for the current client.
    const session = createSession(user.id, sessionContextFromRequest(request));
    recordAudit({ requestId, actorUserId: actor.id, action: 'auth.password_changed', resourceType: 'user', resourceId: actor.id });
    const response = apiOk({ user }, requestId);
    setSessionCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CURRENT_PASSWORD') {
      const actor = getSessionUser(request);
      recordAudit({ requestId, actorUserId: actor?.id, action: 'auth.password_change_failed', resourceType: 'user', resourceId: actor?.id });
      return handleApiError(Object.assign(new Error('当前密码错误'), { status: 401, code: 'INVALID_CURRENT_PASSWORD' }), requestId);
    }
    return handleApiError(error, requestId);
  }
}
