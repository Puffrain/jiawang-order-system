import { apiOk, handleApiError } from '@/lib/api';
import { createProduct, getProduct, listProducts } from '@/lib/catalog-repository';
import { prepareCatalogAssetIds } from '@/lib/catalog-media';
import { assertManualProductReady } from '@/lib/manual-catalog-publish';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseBeautyProductInput, parseJson } from '@/lib/validation';
import type { ProductStatus } from '@/lib/contracts/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const statuses = new Set<ProductStatus>(['draft', 'review_pending', 'needs_changes', 'approved', 'published', 'rejected']);

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'viewer');
    const url = new URL(request.url);
    const requested = url.searchParams.get('status');
    const status = actor.role === 'viewer'
      ? 'published'
      : requested === 'all' ? 'all' : requested && statuses.has(requested as ProductStatus) ? requested as ProductStatus : 'published';
    const result = listProducts({
      status,
      search: url.searchParams.get('search') ?? undefined,
      categoryId: url.searchParams.get('categoryId') ?? undefined,
      limit: Number(url.searchParams.get('limit') || 50),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return apiOk(result, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'reviewer');
    const body = await parseJson(request);
    const submitForReview = Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { publish?: unknown }).publish === true);
    const input = parseBeautyProductInput(body);
    const preparedAssetIds = await prepareCatalogAssetIds(input.assetIds);
    const productInput = preparedAssetIds === undefined ? input : { ...input, assetIds: preparedAssetIds };
    if (submitForReview) assertManualProductReady(productInput);
    const created = createProduct(productInput, { requestId, actorUserId: actor.id, action: submitForReview ? 'catalog.product_submitted' : 'catalog.product_created', resourceType: 'product', metadata: { revision: 1, source: 'manual' } }, submitForReview);
    const product = getProduct(created.id);
    if (!product) throw new Error('人工商品发布后读取失败');
    return apiOk({ product }, requestId, 201);
  } catch (error) { return handleApiError(error, requestId); }
}
