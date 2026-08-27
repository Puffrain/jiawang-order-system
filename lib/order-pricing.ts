import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { emitChatEvent } from "@/lib/chat-events";
import { moneyToFen, reconcileOrderPoints } from "@/lib/loyalty";

const amount = (value: unknown, max = 1_000_000) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max || Math.round(number * 100) !== number * 100) {
    throw new Error("金额必须是非负数且最多保留两位小数");
  }
  return number;
};

export function saveOrderQuote({
  orderId,
  operatorId,
  reason,
  itemPrices,
  discountRateValue,
  manualReductionValue,
  shippingFeeValue,
}: {
  orderId: string;
  operatorId: string;
  reason: string;
  itemPrices: Array<{ orderItemId: string; unitPrice: unknown }>;
  discountRateValue: unknown;
  manualReductionValue: unknown;
  shippingFeeValue: unknown;
}) {
  return db.transaction(() => {
    const order = db.prepare("SELECT buyer_user_id buyerUserId,status,total_amount totalAmount,quote_version quoteVersion,deleted_at deletedAt,order_no orderNo FROM orders WHERE id=?").get(orderId) as {
      buyerUserId: string;
      status: string;
      totalAmount: number;
      quoteVersion: number;
      deletedAt: string | null;
      orderNo: string;
    } | undefined;
    if (!order || order.deletedAt) throw new Error("订单不存在或已删除");
    if (!["pending_review", "pending_payment"].includes(order.status)) throw new Error("当前订单状态不能改价");

    const rows = db.prepare("SELECT id,sku_id skuId,sku_code skuCode,product_name productName,quantity,unit_price unitPrice FROM order_items WHERE order_id=? ORDER BY id").all(orderId) as Array<{
      id: string;
      skuId: string;
      skuCode: string;
      productName: string;
      quantity: number;
      unitPrice: number;
    }>;
    if (!rows.length || itemPrices.length !== rows.length) throw new Error("请提交订单中的全部商品价格");
    const prices = new Map(itemPrices.map(item => [item.orderItemId, amount(item.unitPrice)]));
    if (rows.some(row => !prices.has(row.id))) throw new Error("商品价格项目不完整");

    const discountRate = Number(discountRateValue);
    if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) throw new Error("折扣比例必须在 0 到 1 之间");
    const manualReduction = amount(manualReductionValue);
    const shippingFee = amount(shippingFeeValue);
    const lines = rows.map(row => {
      const unitPrice = prices.get(row.id)!;
      return { ...row, newUnitPrice: unitPrice, lineTotal: Number((unitPrice * row.quantity).toFixed(2)) };
    });
    const subtotal = Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
    const discounted = Number((subtotal * discountRate).toFixed(2));
    const discountAmount = Number((subtotal - discounted + manualReduction).toFixed(2));
    const grossTotal = Math.max(0, Number((discounted - manualReduction + shippingFee).toFixed(2)));
    const version = Number(order.quoteVersion || 0) + 1;
    const loyalty = reconcileOrderPoints(db, orderId, moneyToFen(grossTotal), version);
    const pointsDiscount = loyalty.discountFen / 100;
    const totalAmount = loyalty.cashPayableFen / 100;
    const quoteId = randomUUID();

    db.prepare("INSERT INTO order_quotes(id,order_id,version,subtotal,discount_rate,manual_reduction,points_used,points_discount,shipping_fee,total_amount,reason,operator_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(quoteId, orderId, version, subtotal, discountRate, manualReduction, loyalty.points, pointsDiscount, shippingFee, totalAmount, reason || null, operatorId);
    const insertItem = db.prepare("INSERT INTO order_quote_items(id,quote_id,order_item_id,old_unit_price,new_unit_price,quantity,line_total) VALUES(?,?,?,?,?,?,?)");
    for (const line of lines) {
      insertItem.run(randomUUID(), quoteId, line.id, line.unitPrice, line.newUnitPrice, line.quantity, line.lineTotal);
      db.prepare("UPDATE order_items SET unit_price=?,line_total=? WHERE id=?").run(line.newUnitPrice, line.lineTotal, line.id);
      db.prepare(`INSERT INTO customer_sku_price_history(customer_id,order_id,sku,product_name,quantity,unit_price,operator_id,source) VALUES(?,?,?,?,?,?,?,'quote') ON CONFLICT(order_id,sku) DO UPDATE SET quantity=excluded.quantity,unit_price=excluded.unit_price,operator_id=excluded.operator_id,source='quote',created_at=CURRENT_TIMESTAMP`)
        .run(order.buyerUserId, orderId, line.skuCode, line.productName, line.quantity, line.newUnitPrice, operatorId);
    }
    db.prepare("UPDATE orders SET subtotal=?,discount_amount=?,discount_rate=?,manual_reduction=?,points_used=?,points_discount=?,shipping_fee=?,total_amount=?,quote_version=?,confirmed_quote_version=0,status='pending_review',updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(subtotal, discountAmount, discountRate, manualReduction, loyalty.points, pointsDiscount, shippingFee, totalAmount, version, orderId);
    db.prepare("INSERT INTO order_price_log(order_id,operator_id,old_total,new_total,adjust_reason) VALUES(?,?,?,?,?)")
      .run(orderId, operatorId, order.totalAmount, totalAmount, reason || null);
    emitChatEvent({ buyerUserId: order.buyerUserId, orderId, eventKey: `order.quote:${orderId}:${version}`, content: `订单 ${order.orderNo} 有新报价待确认`, payload: { kind: "quote", orderNo: order.orderNo, totalAmount, version }, quoteVersion: version });
    return { version, subtotal, discountAmount, discountRate, manualReduction, pointsUsed: loyalty.points, pointsDiscount, shippingFee, totalAmount };
  })();
}
