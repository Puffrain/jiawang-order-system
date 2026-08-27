import { apiOk, handleApiError } from '@/lib/api';
import { mergeCandidateGroups, splitCandidateGroup, listCandidateGroups } from '@/lib/catalog/pipeline-candidate';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request); assertCsrfToken(request); assertJsonContentType(request);
    const actor = requireSessionUser(request, 'reviewer');
    const { id } = await context.params;
    const body = await parseJson(request) as Record<string, unknown>;
    const action = body.action;
    if (action === 'merge') {
      if (typeof body.targetGroupId !== 'string') throw new Error('targetGroupId 必填');
      mergeCandidateGroups(id, body.targetGroupId);
      recordAudit({ requestId, actorUserId: actor.id, action: 'group.merged', resourceType: 'group', resourceId: id, metadata: { targetGroupId: body.targetGroupId } });
    } else if (action === 'split') {
      if (!Array.isArray(body.itemIds) || !body.itemIds.every((value) => typeof value === 'string')) throw new Error('itemIds 必须是字符串数组');
      const newId = splitCandidateGroup(id, body.itemIds as string[], typeof body.name === 'string' ? body.name : '');
      recordAudit({ requestId, actorUserId: actor.id, action: 'group.split', resourceType: 'group', resourceId: id, metadata: { newGroupId: newId, itemCount: body.itemIds.length } });
    } else {
      throw new Error('action 必须是 merge 或 split');
    }
    return apiOk({ groups: listCandidateGroups() }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
