import { apiOk, handleApiError } from '@/lib/api';
import { deleteCategory } from '@/lib/catalog-repository';
import { getRequestId, assertSameOrigin, assertCsrfToken } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    const actor = requireSessionUser(request, 'admin');
    const { id } = await context.params;
    deleteCategory(id, {
      requestId,
      actorUserId: actor.id,
      action: 'taxonomy.category_deleted',
      resourceType: 'category',
      resourceId: id,
    });
    return apiOk({ deleted: true }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
