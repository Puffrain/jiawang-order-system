import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { createReview } from "@/lib/reviews";

export async function POST(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  try {
    const review = createReview({ orderId: String(body.orderId || ""), orderItemId: String(body.orderItemId || ""), buyerUserId: auth.session.userId, rating: Number(body.rating), content: String(body.content || "") });
    return NextResponse.json({ review }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "REVIEW_FORBIDDEN" ? 403 : code === "REVIEW_EXISTS" || code === "REVIEW_NOT_ELIGIBLE" ? 409 : 400;
    const message = code === "RATING_INVALID" ? "请选择 1-5 星" : code === "CONTENT_REQUIRED" ? "请填写评价内容" : code === "REVIEW_EXISTS" ? "该商品已评价" : code === "REVIEW_NOT_ELIGIBLE" ? "订单完成、支付并确认收货后才能评价" : "无权评价该订单";
    return NextResponse.json({ error: message }, { status });
  }
}
