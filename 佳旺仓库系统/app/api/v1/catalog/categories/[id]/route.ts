import { apiOk, handleApiError } from '@/lib/api';
import { listCategories, saveCategory } from '@/lib/catalog-repository';
import { recordAudit } from '@/lib/audit';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const { id } = await context.params;
    const current = listCategories(true).find((item) => item.id === id);
    if (!current) throw new Error('分类不存在');
    const body = await parseJson(request) as { active?: boolean; name?: string; code?: string; parentId?: string | null; sortOrder?: number };
    const category = saveCategory({ id, code: body.code ?? current.code, name: body.name ?? current.name, parentId: body.parentId === undefined ? current.parentId : body.parentId, active: body.active === undefined ? current.active : body.active, sortOrder: body.sortOrder ?? current.sortOrder });
    recordAudit({ requestId, actorUserId: actor.id, action: 'taxonomy.category_updated', resourceType: 'category', resourceId: id, metadata: { active: category.active } });
    return apiOk({ category }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
