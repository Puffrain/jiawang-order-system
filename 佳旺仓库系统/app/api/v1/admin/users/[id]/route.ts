import { apiError, apiOk, handleApiError } from '@/lib/api';
import { getUserById, updateUserAdmin } from '@/lib/auth';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson, ValidationError } from '@/lib/validation';
import { isRole } from '@/lib/contracts/platform';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const { id } = await context.params;
    const target = getUserById(id);
    if (!target) return apiError('NOT_FOUND', '用户不存在', requestId, 404);
    const body = await parseJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('请求体必须是 JSON 对象');
    const record = body as Record<string, unknown>;
    if (record.role !== undefined && !isRole(record.role)) throw new ValidationError('role 无效', { role: 'invalid' });
    if (record.isActive !== undefined && typeof record.isActive !== 'boolean') throw new ValidationError('isActive 必须是布尔值');
    let updated: typeof target;
    try {
      updated = updateUserAdmin(id, actor.id, { role: record.role as typeof target.role | undefined, isActive: record.isActive as boolean | undefined }) || target;
    } catch (error) {
      if (error instanceof Error && error.message === 'LAST_ADMIN') return apiError('LAST_ADMIN', '不能移除最后一个活跃管理员', requestId, 409);
      if (error instanceof Error && error.message === 'SELF_DEACTIVATION') return apiError('SELF_DEACTIVATION', '不能停用当前登录账号', requestId, 409);
      throw error;
    }
    recordAudit({
      requestId,
      actorUserId: actor.id,
      action: 'admin.user_updated',
      resourceType: 'user',
      resourceId: id,
      metadata: { role: updated.role, isActive: updated.isActive }
    });
    return apiOk({ user: updated }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    const actor = requireSessionUser(request, 'admin');
    const { id } = await context.params;
    const target = getUserById(id);
    if (!target) return apiError('NOT_FOUND', '用户不存在', requestId, 404);
    if (id === actor.id) return apiError('SELF_DEACTIVATION', '不能停用当前登录账号', requestId, 409);
    let user: typeof target | null;
    try { user = updateUserAdmin(id, actor.id, { isActive: false }); }
    catch (error) {
      if (error instanceof Error && error.message === 'LAST_ADMIN') return apiError('LAST_ADMIN', '不能移除最后一个活跃管理员', requestId, 409);
      if (error instanceof Error && error.message === 'SELF_DEACTIVATION') return apiError('SELF_DEACTIVATION', '不能停用当前登录账号', requestId, 409);
      throw error;
    }
    recordAudit({ requestId, actorUserId: actor.id, action: 'admin.user_deactivated', resourceType: 'user', resourceId: id });
    return apiOk({ user }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
