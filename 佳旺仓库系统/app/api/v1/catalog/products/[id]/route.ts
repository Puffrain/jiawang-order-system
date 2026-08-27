import { apiError, apiOk, handleApiError } from '@/lib/api';
import { deleteRejectedProduct, getProduct, unpublishProduct, updateProduct } from '@/lib/catalog-repository';
import { prepareCatalogAssetIds } from '@/lib/catalog-media';
import { assertManualProductReady } from '@/lib/manual-catalog-publish';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseBeautyProductInput, parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'viewer');
    const { id } = await context.params;
    const product = getProduct(id);
    return product && (actor.role !== 'viewer' || product.status === 'published')
      ? apiOk({ product }, requestId)
      : apiError('NOT_FOUND', '商品不存在', requestId, 404);
  } catch (error) { return handleApiError(error, requestId); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'reviewer');
    const { id } = await context.params;
    const current = getProduct(id);
    if (!current || current.entrySource !== 'manual') throw Object.assign(new Error('只有人工商品可以从这里修改'), { status: 409, code: 'MANUAL_PRODUCT_REQUIRED' });
    const expectedRevision = request.headers.get('if-match')?.replace(/^W\//, '').replaceAll('"', '');
    const body = await parseJson(request);
    const submitForReview = Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { publish?: unknown }).publish === true);
    const input = parseBeautyProductInput(body);
    const preparedAssetIds = await prepareCatalogAssetIds(input.assetIds);
    const productInput = preparedAssetIds === undefined ? input : { ...input, assetIds: preparedAssetIds };
    if (submitForReview) assertManualProductReady(productInput);
    const product = updateProduct(id, productInput, expectedRevision ? Number(expectedRevision) : undefined, { requestId, actorUserId: actor.id, action: submitForReview ? 'catalog.product_submitted' : 'catalog.product_updated', resourceType: 'product', metadata: { source: 'manual' } }, submitForReview);
    const published = getProduct(product.id);
    if (!published) throw new Error('人工商品发布后读取失败');
    const response = apiOk({ product: published }, requestId);
    response.headers.set('etag', `"${published.revision}"`);
    return response;
  } catch (error) { return handleApiError(error, requestId); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    const actor = requireSessionUser(request, 'reviewer');
    const { id } = await context.params;
    const current = getProduct(id);
    if (current?.status === 'published') {
      const product = unpublishProduct(id, { requestId, actorUserId: actor.id, action: 'catalog.product_unpublished', resourceType: 'product', metadata: { status: 'published' } });
      return apiOk({ unpublished: true, id, product }, requestId);
    }
    deleteRejectedProduct(id, { requestId, actorUserId: actor.id, action: 'catalog.product_deleted', resourceType: 'product', metadata: { status: 'rejected' } });
    return apiOk({ deleted: true, id }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
