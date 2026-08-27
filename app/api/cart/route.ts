import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { positiveInt } from "@/lib/validation";
import { priceSku } from "@/lib/pricing";
import { refreshWarehouseStock } from "@/lib/warehouse-inventory";

export async function GET() {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const rows = db.prepare(`SELECT sku_id skuId,quantity FROM cart_items WHERE user_id=? ORDER BY updated_at DESC`).all(auth.session.userId) as Array<{ skuId:string;quantity:number }>;
  try { await refreshWarehouseStock(rows.map(row => row.skuId)); } catch { /* last synchronized snapshot remains visible */ }
  const itemInfo = db.prepare(`SELECT c.sku_id skuId,c.quantity,s.sku_code skuCode,s.spec_name specName,s.stock,p.name productName,p.status,p.archived_at archivedAt,p.permanently_hidden_at permanentlyHiddenAt
    FROM cart_items c
    LEFT JOIN product_skus s ON s.id=c.sku_id
    LEFT JOIN products p ON p.id=s.product_id
    WHERE c.user_id=?
    ORDER BY c.updated_at DESC`);
  const items=[]; const invalidItems:Array<{skuId:string;quantity:number;skuCode:string|null;specName:string;productName:string;stock:number;reason:string}>=[];
  for(const row of itemInfo.all(auth.session.userId) as Array<{skuId:string;quantity:number;skuCode:string|null;specName:string|null;stock:number|null;productName:string|null;status:string|null;archivedAt:string|null;permanentlyHiddenAt:string|null}>){
    const priced=priceSku(row.skuId,row.quantity);
    if(priced){items.push(priced);continue;}
    const reason=!row.productName||!row.specName?"商品规格已删除":row.permanentlyHiddenAt?"商品已移出销售":row.archivedAt?"商品已归档":row.status!=="active"?"商品已下架":Number(row.stock||0)<row.quantity?"库存不足":"商品状态已变化";
    invalidItems.push({skuId:row.skuId,quantity:row.quantity,skuCode:row.skuCode||null,specName:row.specName||"已失效规格",productName:row.productName||"已失效商品",stock:Number(row.stock||0),reason});
  }
  return NextResponse.json({ items, invalidItems });
}

export async function POST(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({}));
  const quantity = positiveInt(body.quantity);
  const skuId = String(body.skuId ?? "");
  if (!quantity) return NextResponse.json({ error: "数量无效" }, { status: 400 });
  try { await refreshWarehouseStock([skuId]); } catch { /* checkout still performs the authoritative reservation */ }
  const priced = priceSku(skuId, quantity);
  if (!priced) return NextResponse.json({ error: "商品不存在或库存不足" }, { status: 409 });
  db.prepare(`INSERT INTO cart_items(id,user_id,sku_id,quantity) VALUES(?,?,?,?) ON CONFLICT(user_id,sku_id) DO UPDATE SET quantity=excluded.quantity,updated_at=CURRENT_TIMESTAMP`).run(randomUUID(), auth.session.userId, skuId, quantity);
  return NextResponse.json({ item: priced });
}

export async function DELETE(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const skuId = new URL(request.url).searchParams.get("skuId");
  if (!skuId) return NextResponse.json({ error: "缺少商品" }, { status: 400 });
  db.prepare("DELETE FROM cart_items WHERE user_id=? AND sku_id=?").run(auth.session.userId, skuId);
  return NextResponse.json({ ok: true });
}
