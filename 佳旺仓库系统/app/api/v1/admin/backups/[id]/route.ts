import { apiError, apiOk, handleApiError } from '@/lib/api';
import { getBackup } from '@/lib/backup/service';
import { getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'admin');
    const { id } = await context.params;
    const backup = getBackup(id);
    return backup ? apiOk({ backup }, requestId) : apiError('NOT_FOUND', '备份任务不存在', requestId, 404);
  } catch (error) { return handleApiError(error, requestId); }
}
