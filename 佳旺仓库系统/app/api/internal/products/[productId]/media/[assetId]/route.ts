import { getDb } from "../../../../../../../lib/db";
import { verifyIntegrationRequest } from "../../../../../../../lib/integration-auth";
import { getPipelineRuntime } from "../../../../../../../lib/jobs/runtime";
import { MediaAccessError, openAssetForRole } from "../../../../../../../lib/pipeline/media";

type Context = { params: Promise<{ productId: string; assetId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  if (!verifyIntegrationRequest(request, "")) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { productId, assetId } = await context.params;
  const product = getDb().prepare("SELECT status FROM products WHERE id=?").get(productId) as { status: string } | undefined;
  if (product?.status !== "published") return Response.json({ error: "media not published" }, { status: 404 });

  const linked = getDb().prepare("SELECT asset_id assetId FROM product_assets WHERE product_id=?").all(productId) as Array<{ assetId: string }>;
  const runtime = getPipelineRuntime();
  const requested = runtime.store.getAsset(assetId);
  const allowed = requested?.derivativeKind && linked.some((row) => row.assetId === assetId || row.assetId === requested.sourceAssetId);
  if (!allowed) return Response.json({ error: "media not published" }, { status: 404 });

  try {
    const { asset, stream } = await openAssetForRole(runtime.store, assetId, "viewer");
    return new Response(stream, { headers: {
      "content-type": asset.mimeType,
      "content-length": String(asset.bytes),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    } });
  } catch (error) {
    const status = error instanceof MediaAccessError ? error.status : 500;
    return Response.json({ error: "media unavailable" }, { status });
  }
}
