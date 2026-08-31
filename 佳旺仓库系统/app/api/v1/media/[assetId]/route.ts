import { apiError, handleApiError } from "../../../../../lib/api";
import { getRequestId } from "../../../../../lib/security";
import { requireSessionUser } from "../../../../../lib/session";
import { getDb } from "../../../../../lib/db";
import { getPipelineRuntime } from "../../../../../lib/jobs/runtime";
import { openAssetForRole, safeDownloadName } from "../../../../../lib/pipeline/media";

type Context = { params: Promise<{ assetId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, "viewer");
    const { assetId } = await context.params;
    if (actor.role === 'viewer') {
      const visible = getDb().prepare(`SELECT 1 FROM product_assets pa JOIN products p ON p.id = pa.product_id WHERE p.status = 'published' AND pa.asset_id = ? LIMIT 1`).get(assetId);
      if (!visible) return apiError('MEDIA_FORBIDDEN', '媒体不属于已发布商品', requestId, 403);
    }
    const { asset, stream } = await openAssetForRole(getPipelineRuntime().store, assetId, actor.role);
    const headers = new Headers({ "content-type": asset.mimeType, "content-length": String(asset.bytes), "cache-control": "private, no-store", etag: `"${asset.sha256}"`, "content-disposition": `inline; filename="${safeDownloadName(asset.filename)}"`, "x-request-id": requestId, "x-content-type-options": "nosniff" });
    return new Response(stream, { status: 200, headers });
  } catch (error) { return handleApiError(error, requestId); }
}
