import { apiError, apiOk } from '@/lib/api';
import { getDb } from '@/lib/db';
import { verifyIntegrationRequest } from '@/lib/integration-auth';
import { getRequestId } from '@/lib/security';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const raw = await request.text();
  if (!verifyIntegrationRequest(request, raw)) return apiError('UNAUTHORIZED', 'Unauthorized', requestId, 401);
  const body = JSON.parse(raw || '{}') as { variantIds?: unknown };
  if (!Array.isArray(body.variantIds) || body.variantIds.length > 500 || body.variantIds.some(id => typeof id !== 'string')) return apiError('INVALID', 'Invalid variants', requestId, 400);
  const ids = [...new Set(body.variantIds as string[])];
  if (!ids.length) return apiOk({ levels: [] }, requestId);
  const placeholders = ids.map(() => '?').join(',');
  const levels = getDb().prepare(`SELECT id variantId,COALESCE(stock,0) stock FROM product_variants WHERE id IN (${placeholders})`).all(...ids);
  return apiOk({ levels }, requestId);
}
