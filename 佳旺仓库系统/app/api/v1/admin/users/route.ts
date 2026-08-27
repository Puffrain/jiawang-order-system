import { apiOk, handleApiError } from '@/lib/api';
import { createUser, listUsers } from '@/lib/auth';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseCreateUserInput, parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'admin');
    return apiOk({ users: listUsers() }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const input = parseCreateUserInput(await parseJson(request));
    const user = createUser(input);
    recordAudit({
      requestId,
      actorUserId: actor.id,
      action: 'admin.user_created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { username: user.username, role: user.role }
    });
    return apiOk({ user }, requestId, 201);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
