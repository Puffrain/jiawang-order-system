import { apiError, apiOk, handleApiError } from '@/lib/api';
import { getRequestId } from '@/lib/security';
import { getSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const user = getSessionUser(request);
    if (!user) return apiError('UNAUTHENTICATED', '请先登录', requestId, 401);
    return apiOk({ user }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

