import { apiOk, handleApiError } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertSameOrigin, clearCsrfCookie, getRequestId } from '@/lib/security';
import {
  clearSessionCookie,
  getSessionToken,
  getSessionUser,
  revokeSessionToken
} from '@/lib/session';
import { assertNotInMaintenance } from '@/lib/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertNotInMaintenance();
    const token = getSessionToken(request);
    const user = getSessionUser(request);
    if (token) revokeSessionToken(token);
    if (user) {
      recordAudit({ requestId, actorUserId: user.id, action: 'auth.logout', resourceType: 'user', resourceId: user.id });
    }
    const response = apiOk({ loggedOut: true }, requestId);
    clearSessionCookie(response);
    clearCsrfCookie(response);
    return response;
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
