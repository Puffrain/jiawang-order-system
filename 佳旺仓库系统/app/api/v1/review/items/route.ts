import { apiOk, handleApiError } from '@/lib/api';
import { listReviewProducts } from '@/lib/catalog-repository';
import { listCandidateAssetIds, listCandidateEvidence } from '@/lib/catalog/pipeline-candidate';
import { getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'reviewer');
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') || 100);
    const productId = url.searchParams.get('productId')?.trim();
    const items = listReviewProducts(Math.min(Math.max(limit, 1), 500))
      .filter((item) => !productId || item.id === productId)
      .map((product) => {
        const evidence = listCandidateEvidence(product.id);
        const assets = listCandidateAssetIds(product.id);
        const confidenceValues = evidence.map((entry) => entry.confidence).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const confidence = confidenceValues.length ? Math.min(...confidenceValues) : undefined;
        return {
          ...product,
          source: 'catalog' as const,
          product,
          productName: product.name,
          categoryId: product.categoryId,
          evidence,
          confidence,
          images: assets.map((asset) => ({
            id: asset.assetId,
            previewUrl: `/api/v1/media/${encodeURIComponent(asset.assetId)}`,
            thumbnailUrl: `/api/v1/media/${encodeURIComponent(asset.assetId)}`,
          })),
        };
      });
    return apiOk({ items, total: items.length }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
