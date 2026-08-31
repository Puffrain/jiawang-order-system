import { apiOk, handleApiError } from '@/lib/api';
import { listCategories, saveCategory } from '@/lib/catalog-repository';
import { recordAudit } from '@/lib/audit';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'viewer');
    return apiOk({ categories: listCategories(actor.role === 'admin' && new URL(request.url).searchParams.get('all') === 'true') }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const category = saveCategory(await parseJson(request) as Parameters<typeof saveCategory>[0]);
    recordAudit({ requestId, actorUserId: actor.id, action: 'taxonomy.category_saved', resourceType: 'category', resourceId: category.id, metadata: { code: category.code, active: category.active } });
    return apiOk({ category }, requestId, 201);
  } catch (error) { return handleApiError(error, requestId); }
}
