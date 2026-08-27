import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";

export async function POST() {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  return NextResponse.json({ error: "旧改价入口已停用，请在订单详情中创建新版报价" }, { status: 410 });
}

export async function GET(request: Request) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { default: db } = await import("@/lib/db");
  const { searchParams } = new URL(request.url);
  const customerId = searchParams.get("customerId");
  const skus = searchParams.getAll("sku").slice(0, 50);
  if (!customerId || !skus.length) return NextResponse.json({ prices: [] });
  const placeholders = skus.map(() => "?").join(",");
  const prices = db.prepare(`SELECT customer_id customerId,sku,product_name productName,quantity,unit_price unitPrice,order_id orderId,created_at createdAt FROM customer_sku_price_history h WHERE customer_id=? AND sku IN (${placeholders}) AND created_at=(SELECT MAX(created_at) FROM customer_sku_price_history WHERE customer_id=h.customer_id AND sku=h.sku) ORDER BY created_at DESC`).all(customerId, ...skus);
  return NextResponse.json({ prices });
}
