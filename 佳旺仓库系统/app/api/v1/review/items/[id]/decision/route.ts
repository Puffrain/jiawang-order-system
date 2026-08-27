import { apiError, apiOk, handleApiError } from '@/lib/api';
import { reviewProduct } from '@/lib/catalog-repository';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseBeautyProductInput, parseJson } from '@/lib/validation';
import { getPipelineCandidateLink } from '@/lib/catalog/pipeline-candidate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'reviewer');
    const { id } = await context.params;
    if (getPipelineCandidateLink(id)) {
      // Pipeline candidates must use the outbox-backed review endpoint so the
      // product and import-item projections cannot diverge.
      return apiError('PIPELINE_REVIEW_REQUIRED', '该商品属于导入任务，请从任务审核队列处理', requestId, 409);
    }
    const body = await parseJson(request) as { decision?: string; reason?: string; revision?: number; product?: unknown };
    if (!body.decision || !['approve', 'reject', 'needs_changes'].includes(body.decision)) throw new Error('审核决定无效');
    if (!Number.isSafeInteger(body.revision) || (body.revision ?? 0) < 1) {
      return apiError('REVIEW_REVISION_REQUIRED', '审核版本无效，请刷新商品后重试', requestId, 400);
    }
    const reviewInput = body.product === undefined ? undefined : parseBeautyProductInput(body.product);
    const product = reviewProduct(
      id,
      { id: actor.id, role: actor.role as 'admin' | 'reviewer' },
      body.decision as 'approve' | 'reject' | 'needs_changes',
      body.reason,
      body.revision,
      undefined,
      reviewInput,
      { requestId, actorUserId: actor.id, action: `review.${body.decision}`, resourceType: 'product', resourceId: id },
    );
    return apiOk({ product }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
