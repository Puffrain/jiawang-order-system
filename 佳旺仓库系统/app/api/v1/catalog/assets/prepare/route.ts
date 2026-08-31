import { recordAudit } from '@/lib/audit';
import { prepareManualProductAsset } from '@/lib/manual-product-media';
import { handlePipelineError, ok, publicAsset, readJson, requestId, requirePipelineRole } from '@/lib/jobs/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, 'reviewer');
    const body = await readJson(request, 8 * 1024);
    if (typeof body.assetId !== 'string') throw Object.assign(new Error('图片 ID 不能为空'), { code: 'ASSET_ID', status: 400 });
    const asset = await prepareManualProductAsset(body.assetId);
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'catalog.manual_asset_prepared', resourceType: 'asset', resourceId: asset.id, metadata: { sourceAssetId: body.assetId, bytes: asset.bytes, mimeType: asset.mimeType } });
    return ok({ asset: publicAsset(asset), url: `/api/v1/media/${encodeURIComponent(asset.id)}` }, id, 201);
  } catch (error) {
    return handlePipelineError(error, id);
  }
}
