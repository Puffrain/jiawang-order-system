import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/audit";
import { requireApiRole } from "@/lib/auth";
import { getProductRecommendationConfig, setProductRecommendations } from "@/lib/product-catalog";
import { requestIp } from "@/lib/security";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Context) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const result = getProductRecommendationConfig(id);
  return result ? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "商品不存在或已归档" }, { status: 404 });
}

export async function PUT(request: Request, { params }: Context) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.productIds)) return NextResponse.json({ error: "推荐商品数据无效" }, { status: 400 });
  try {
    const recommendationIds = setProductRecommendations(id, body.productIds.map(String));
    writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "product.recommendations.updated", objectType: "product", objectId: id, ip: requestIp(request), metadata: { recommendationIds } });
    return NextResponse.json({ ok: true, recommendationIds });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json({ error: code === "PRODUCT_NOT_FOUND" ? "商品不存在或已归档" : "推荐商品数据无效" }, { status: code === "PRODUCT_NOT_FOUND" ? 404 : 400 });
  }
}
