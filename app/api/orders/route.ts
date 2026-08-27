import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { priceSku } from "@/lib/pricing";
import { cleanText } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { emitChatEvent } from "@/lib/chat-events";
import { orderStatusLabel } from "@/lib/order-status";
import { moneyToFen, reserveOrderPoints } from "@/lib/loyalty";
import { processWarehouseReleases, queueWarehouseRelease, refreshWarehouseStock, releaseWarehouseStock, reserveWarehouseStock } from "@/lib/warehouse-inventory";
import { notifyNewOrder } from "@/lib/wecom";

export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const scope = new URL(request.url).searchParams.get("scope") || "all";
  let where = "WHERE o.deleted_at IS NULL";
  let args: unknown[] = [];
  if (auth.session.role === "buyer") { where += " AND o.buyer_user_id=?"; args = [auth.session.userId]; }
  else if (scope === "completed") where += " AND o.status='closed'";
  else if (scope === "deleted") where = "WHERE o.deleted_at IS NOT NULL";
  const rows = db.prepare(`SELECT o.id,o.order_no orderNo,o.status,o.subtotal,o.discount_amount discountAmount,o.discount_rate discountRate,o.manual_reduction manualReduction,o.points_used pointsUsed,o.points_discount pointsDiscount,o.shipping_fee shippingFee,o.total_amount totalAmount,o.quote_version quoteVersion,o.confirmed_quote_version confirmedQuoteVersion,o.created_at createdAt,o.updated_at updatedAt,o.closed_at closedAt,o.deleted_at deletedAt,o.deleted_reason deletedReason,u.display_name buyerName,u.phone buyerPhone FROM orders o JOIN users u ON u.id=o.buyer_user_id ${where} ORDER BY COALESCE(o.deleted_at,o.closed_at,o.created_at) DESC`).all(...args) as Array<Record<string, unknown> & { status: string; quoteVersion: number; confirmedQuoteVersion: number }>;
  return NextResponse.json({ orders: rows.map(order => ({ ...order, statusLabel: orderStatusLabel(order.status, { quoteVersion: order.quoteVersion, confirmedQuoteVersion: order.confirmedQuoteVersion }) })), scope }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const profile = db.prepare("SELECT profile_completed profileCompleted FROM customer_profile WHERE user_id=?").get(auth.session.userId) as { profileCompleted: number } | undefined;
  if (!profile?.profileCompleted) return NextResponse.json({ error: "请先完成客户资料并保存至少一个收货地址" }, { status: 409 });
  const body = await request.json().catch(() => ({}));
  const addressId = String(body.addressId ?? "");
  const idempotencyKey = String(body.idempotencyKey ?? "").slice(0, 100);
  const pointsToUse = Number(body.pointsToUse ?? 0);
  if (!addressId || idempotencyKey.length < 8 || !Number.isSafeInteger(pointsToUse) || pointsToUse < 0) return NextResponse.json({ error: "订单参数不完整" }, { status: 400 });
  const existing = db.prepare("SELECT id,order_no orderNo,total_amount totalAmount,points_used pointsUsed,points_discount pointsDiscount,status FROM orders WHERE buyer_user_id=? AND idempotency_key=?").get(auth.session.userId, idempotencyKey) as { status: string } | undefined;
  if (existing) return NextResponse.json({ order: { ...existing, statusLabel: orderStatusLabel(existing.status) }, replayed: true });

  void processWarehouseReleases().catch(() => undefined);
  const orderId = randomUUID();
  let warehouseReserved = false;
  try {
    const cartSnapshot = db.prepare(`SELECT c.sku_id skuId,c.quantity,s.warehouse_variant_id warehouseVariantId FROM cart_items c JOIN product_skus s ON s.id=c.sku_id WHERE c.user_id=?`).all(auth.session.userId) as Array<{ skuId: string; quantity: number; warehouseVariantId: string | null }>;
    if (!cartSnapshot.length) throw new Error("EMPTY_CART");
    try { await refreshWarehouseStock(cartSnapshot.map(item => item.skuId)); } catch { /* reservation below remains authoritative */ }
    // Reject an outdated cart before asking the warehouse to reserve anything.
    // The same check is repeated inside the order transaction below.
    if (cartSnapshot.some((item) => !priceSku(item.skuId, item.quantity))) throw new Error("STOCK");
    const warehouseLines = cartSnapshot.filter(item => item.warehouseVariantId).map(item => ({ variantId: item.warehouseVariantId!, quantity: item.quantity }));
    if (warehouseLines.length) {
      await reserveWarehouseStock({ operationId: `reserve-${orderId}`, orderId, lines: warehouseLines });
      warehouseReserved = true;
    }

    const order = db.transaction(() => {
      const address = db.prepare("SELECT recipient_name recipientName,phone,province,city,district,detail FROM addresses WHERE id=? AND user_id=?").get(addressId, auth.session.userId);
      if (!address) throw new Error("ADDRESS");
      const cart = db.prepare("SELECT sku_id skuId,quantity FROM cart_items WHERE user_id=?").all(auth.session.userId) as Array<{ skuId: string; quantity: number }>;
      if (!cart.length) throw new Error("EMPTY_CART");
      const lines = cart.map(item => priceSku(item.skuId, item.quantity));
      if (lines.some(line => !line)) throw new Error("STOCK");
      const priced = lines.filter(Boolean) as NonNullable<ReturnType<typeof priceSku>>[];
      const subtotal = Number(priced.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
      const orderNo = `HS${new Date().toISOString().slice(0, 10).replaceAll("-", "")}${Date.now().toString().slice(-7)}`;
      db.prepare("INSERT INTO orders(id,order_no,buyer_user_id,status,subtotal,discount_amount,shipping_fee,total_amount,recipient_snapshot,customer_remark,idempotency_key) VALUES(?,?,?,'pending_review',?,0,0,?,?,?,?)").run(orderId, orderNo, auth.session.userId, subtotal, subtotal, JSON.stringify(address), cleanText(body.remark, 300) || null, idempotencyKey);
      const loyalty = reserveOrderPoints(db, { orderId, userId: auth.session.userId, grossAmountFen: moneyToFen(subtotal), pointsToUse });
      const pointsDiscount = loyalty.discountFen / 100;
      const totalAmount = loyalty.cashPayableFen / 100;
      db.prepare("UPDATE orders SET points_used=?,points_discount=?,total_amount=? WHERE id=?").run(loyalty.points, pointsDiscount, totalAmount, orderId);
      const insert = db.prepare("INSERT INTO order_items(id,order_id,sku_id,sku_code,product_name,spec_name,quantity,list_price,unit_price,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)");
      for (const line of priced) {
        const source = db.prepare("SELECT warehouse_variant_id warehouseVariantId FROM product_skus WHERE id=?").get(line.skuId) as { warehouseVariantId: string | null };
        if (!source.warehouseVariantId) {
          const stock = db.prepare("UPDATE product_skus SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND stock>=?").run(line.quantity, line.skuId, line.quantity);
          if (stock.changes !== 1) throw new Error("STOCK");
        }
        insert.run(randomUUID(), orderId, line.skuId, line.skuCode, line.productName, line.specName, line.quantity, line.listPrice, line.unitPrice, line.lineTotal);
      }
      db.prepare("DELETE FROM cart_items WHERE user_id=?").run(auth.session.userId);
      emitChatEvent({ buyerUserId: auth.session.userId, orderId, eventKey: `order.created:${orderId}`, content: `新订单 ${orderNo} 已提交`, payload: { kind: "order", orderNo, totalAmount }, fromRole: "buyer" });
      return { id: orderId, orderNo, totalAmount, pointsUsed: loyalty.points, pointsDiscount, status: "pending_review" };
    })();
    writeAudit({ actorUserId: auth.session.userId, actorRole: "buyer", action: "order.created", objectType: "order", objectId: order.id, ip: requestIp(request), metadata: { orderNo: order.orderNo, totalAmount: order.totalAmount } });
    const customer = db.prepare("SELECT u.display_name displayName,u.phone,p.shop_name shopName FROM users u LEFT JOIN customer_profile p ON p.user_id=u.id WHERE u.id=?").get(auth.session.userId) as { displayName: string | null; phone: string | null; shopName: string | null } | undefined;
    if (customer) void notifyNewOrder({ customer, orderNo: order.orderNo, totalAmount: order.totalAmount });
    if (warehouseReserved) { try { await refreshWarehouseStock(cartSnapshot.map(item => item.skuId)); } catch { /* checkout is committed; the next catalog read refreshes the snapshot */ } }
    return NextResponse.json({ order: { ...order, statusLabel: orderStatusLabel(order.status) } }, { status: 201 });
  } catch (error) {
    if (warehouseReserved) { try { await releaseWarehouseStock(orderId); } catch { queueWarehouseRelease(orderId); } }
    const code = error instanceof Error ? error.message : "";
    const message = code === "ADDRESS" ? "收货地址不存在" : code === "EMPTY_CART" ? "购物车为空" : code.includes("积分") ? code : code === "WAREHOUSE_INTEGRATION_UNAVAILABLE" ? "仓库库存服务暂时不可用，请稍后重试" : "库存发生变化，请刷新后重试";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
