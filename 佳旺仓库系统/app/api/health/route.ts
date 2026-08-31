import { apiError, apiOk } from '@/lib/api';
import { healthCheck } from '@/lib/db';
import { getRequestId } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const database = healthCheck();
    return apiOk(
      {
        status: 'ok',
        service: 'jiawang-warehouse-web',
        database,
        timestamp: new Date().toISOString()
      },
      requestId
    );
  } catch {
    return apiError('NOT_READY', '服务尚未就绪', requestId, 503);
  }
}

