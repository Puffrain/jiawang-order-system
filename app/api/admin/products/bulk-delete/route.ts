import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/audit";
import { requireApiRole } from "@/lib/auth";
import { applyProductLifecycle, type ProductLifecycleAction } from "@/lib/product-catalog";
import { requestIp } from "@/lib/security";

function lifecycleAction(value: unknown): ProductLifecycleAction {
  return value === "archive" ? "archive" : value === "permanent-hide" ? "permanent-hide" : "auto";
}

async function handleBulkDelete(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({})) as { productIds?: unknown; action?: unknown };
  const productIds = Array.isArray(body.productIds)
    ? [...new Set(body.productIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100))]
    : [];
  if (!productIds.length || productIds.length > 100) return NextResponse.json({ error: "商品列表无效" }, { status: 400 });
  const action = lifecycleAction(body.action);
  const results = productIds.map((productId) => applyProductLifecycle(productId, action));
  for (const result of results) {
    writeAudit({
      actorUserId: auth.session.userId, actorRole: "owner", action: `product.${result.action}`, objectType: "product", objectId: result.productId,
      ip: requestIp(request), metadata: { bulk: true, ok: result.ok, reason: result.reason },
    });
  }
  return NextResponse.json({ ok: results.every((result) => result.ok), results }, { status: results.some((result) => result.ok) ? 200 : 404 });
}

export const POST = handleBulkDelete;
export const DELETE = handleBulkDelete;
