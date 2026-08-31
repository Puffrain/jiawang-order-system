import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { emitChatEvent } from "@/lib/chat-events";
import { orderStatusLabel } from "@/lib/order-status";
import { commitOrderPoints, completeOrderPoints, releaseOrderPoints } from "@/lib/loyalty";
import { queueWarehouseRelease, releaseWarehouseStock } from "@/lib/warehouse-inventory";

const allowed = {
  pending_review: ["pending_payment", "closed"],
  pending_payment: ["pending_shipment", "closed"],
  pending_shipment: ["shipped", "closed"],
  shipped: ["closed"],
  closed: [],
} as Record<string, string[]>;

type OrderState = {
  status: string;
  buyerUserId: string;
  orderNo: string;
  quoteVersion: number;
  confirmedQuoteVersion: number;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const next = String(body.status ?? "");

  try {
    const transition = db.transaction(() => {
      const row = db.prepare("SELECT status,buyer_user_id buyerUserId,order_no orderNo,quote_version quoteVersion,confirmed_quote_version confirmedQuoteVersion FROM orders WHERE id=? AND deleted_at IS NULL").get(id) as OrderState | undefined;
      if (!row) throw new Error("NOT_FOUND");
      if (!allowed[row.status]?.includes(next)) throw new Error("INVALID_TRANSITION");
      if (next === "pending_payment" && row.quoteVersion > row.confirmedQuoteVersion) throw new Error("QUOTE_UNCONFIRMED");

      const updated = db.prepare("UPDATE orders SET status=?,closed_at=CASE WHEN ?='closed' THEN CURRENT_TIMESTAMP ELSE closed_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status=?")
        .run(next, next, id, row.status);
      if (updated.changes !== 1) throw new Error("INVALID_TRANSITION");

      if (row.status === "pending_payment" && next === "pending_shipment") commitOrderPoints(db, id);
      else if (row.status === "shipped" && next === "closed") completeOrderPoints(db, id);
      else if (next === "closed") releaseOrderPoints(db, id);

      emitChatEvent({ buyerUserId: row.buyerUserId, orderId: id, eventKey: `order.status:${id}:${next}`, content: `订单 ${row.orderNo} 状态更新为：${orderStatusLabel(next)}`, payload: { kind: "status", orderNo: row.orderNo, status: next } });
      return row;
    })();

    const hasWarehouseReservation = Boolean(db.prepare("SELECT 1 FROM order_items i JOIN product_skus s ON s.id=i.sku_id WHERE i.order_id=? AND s.warehouse_variant_id IS NOT NULL LIMIT 1").get(id));
    if (next === "closed" && transition.status !== "shipped" && hasWarehouseReservation) {
      try { await releaseWarehouseStock(id, `release-${id}`); } catch { queueWarehouseRelease(id); }
    }
    writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "order.status.updated", objectType: "order", objectId: id, ip: requestIp(request), metadata: { from: transition.status, to: next } });
    return NextResponse.json({ ok: true, status: next, statusLabel: orderStatusLabel(next) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "NOT_FOUND") return NextResponse.json({ error: "订单不存在或已删除" }, { status: 404 });
    if (code === "QUOTE_UNCONFIRMED") return NextResponse.json({ error: "客户尚未确认最新报价，不能进入待付款" }, { status: 409 });
    return NextResponse.json({ error: code === "INVALID_TRANSITION" ? "订单状态流转无效" : code || "订单状态更新失败" }, { status: 409 });
  }
}
