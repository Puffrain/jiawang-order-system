import { apiOk, handleApiError } from '@/lib/api';
import { getCachedDeepSeekCapabilities, getDeepSeekConfig } from '@/lib/deepseek-config';
import { getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'viewer');
    const cached = getCachedDeepSeekCapabilities();
    if (cached) return apiOk(cached, requestId);
    const config = getDeepSeekConfig();
    // A GET from dashboards must never trigger a billable image probe. Only
    // the explicit administrator probe endpoint performs network I/O.
    return apiOk({ provider: 'deepseek', available: false, vision: false, acceptsDataUrl: true, model: config.model, reason: '管理员尚未执行视觉能力探测' }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
