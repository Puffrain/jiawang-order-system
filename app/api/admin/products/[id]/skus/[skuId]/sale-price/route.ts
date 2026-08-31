import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/audit";
import { requireApiRole } from "@/lib/auth";
import { getWarehouseSkuPrice, setWarehouseSkuPriceOverride } from "@/lib/product-catalog";
import { requestIp } from "@/lib/security";

type Context = { params: Promise<{ id: string; skuId: string }> };

export async function GET(_: Request, { params }: Context) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id, skuId } = await params;
  const sku = getWarehouseSkuPrice(id, skuId);
  return sku ? NextResponse.json({ sku }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "仓库 SKU 不存在" }, { status: 404 });
}

export async function PUT(request: Request, { params }: Context) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id, skuId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("salePriceOverride" in body)) return NextResponse.json({ error: "销售覆盖价无效" }, { status: 400 });
  try {
    const sku = setWarehouseSkuPriceOverride(id, skuId, body.salePriceOverride);
    writeAudit({
      actorUserId: auth.session.userId, actorRole: "owner", action: sku.salePriceOverride === null ? "product.sale_price_override.cleared" : "product.sale_price_override.updated",
      objectType: "product_sku", objectId: skuId, ip: requestIp(request), metadata: { productId: id, warehouseBasePrice: sku.warehouseBasePrice, salePriceOverride: sku.salePriceOverride, effectiveBasePrice: sku.basePrice },
    });
    return NextResponse.json({ ok: true, sku });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json({ error: code === "WAREHOUSE_SKU_NOT_FOUND" ? "仓库 SKU 不存在或商品已归档" : "销售覆盖价无效" }, { status: code === "WAREHOUSE_SKU_NOT_FOUND" ? 404 : 400 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  return PUT(new Request(request.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ salePriceOverride: null }) }), { params });
}
