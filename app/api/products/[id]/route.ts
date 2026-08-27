import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/audit";
import { requireApiRole } from "@/lib/auth";
import db from "@/lib/db";
import { applyProductLifecycle, getProductDetail, parseProductInput, restoreProduct, saveProduct, setProductRecommendations, uploadRoot, type ProductLifecycleAction } from "@/lib/product-catalog";
import { requestIp } from "@/lib/security";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: RouteContext) {
  const auth = await requireApiRole();
  if (auth.response) return auth.response;
  const { id } = await params;
  const product = getProductDetail(id, auth.session.role);
  return product
    ? NextResponse.json({ product })
    : NextResponse.json({ error: "商品不存在" }, { status: 404 });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "商品数据无效" }, { status: 400 });
  }

  if (body.action === "status") {
    const status = body.status === "active" ? "active" : body.status === "inactive" ? "inactive" : null;
    if (!status) return NextResponse.json({ error: "商品状态无效" }, { status: 400 });
    const source=db.prepare("SELECT warehouse_product_id warehouseProductId FROM products WHERE id=? AND archived_at IS NULL AND permanently_hidden_at IS NULL").get(id) as {warehouseProductId:string|null}|undefined;
    if(!source)return NextResponse.json({ error: "商品不存在或已归档" }, { status: 404 });
    if(source.warehouseProductId)return NextResponse.json({ error: "仓库同步商品状态由仓库管理" }, { status: 409 });
    const result = db.prepare("UPDATE products SET status=?,first_activated_at=CASE WHEN ?='active' THEN COALESCE(first_activated_at,CURRENT_TIMESTAMP) ELSE first_activated_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND archived_at IS NULL AND permanently_hidden_at IS NULL").run(status, status, id);
    if (!result.changes) return NextResponse.json({ error: "商品不存在或已归档" }, { status: 404 });
    writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: `product.${status}`, objectType: "product", objectId: id, ip: requestIp(request) });
    return NextResponse.json({ ok: true, status });
  }

  if(body.action==="recommendations") {
    try {
      const recommendationIds=setProductRecommendations(id,Array.isArray(body.productIds)?body.productIds.map(String):[]);
      writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.recommendations.updated",objectType:"product",objectId:id,ip:requestIp(request),metadata:{recommendationIds}});
      return NextResponse.json({ok:true,recommendationIds});
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      return NextResponse.json({error:code==="PRODUCT_NOT_FOUND"?"商品不存在或已归档":"推荐商品数据无效"},{status:code==="PRODUCT_NOT_FOUND"?404:400});
    }
  }

  if(body.action==="merchant-content") {
    const source=db.prepare("SELECT warehouse_product_id warehouseProductId FROM products WHERE id=? AND archived_at IS NULL AND permanently_hidden_at IS NULL").get(id) as {warehouseProductId:string|null}|undefined;
    if(!source)return NextResponse.json({error:"商品不存在或已归档"},{status:404});
    if(!source.warehouseProductId)return NextResponse.json({error:"该操作仅用于仓库同步商品"},{status:400});
    const description=typeof body.description==="string"?body.description.trim().slice(0,3000):"";
    db.prepare("UPDATE products SET description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(description||null,id);
    writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.merchant_content.updated",objectType:"product",objectId:id,ip:requestIp(request)});
    return NextResponse.json({ok:true,id});
  }

  if(body.action==="restore") {
    const result=restoreProduct(id);
    if(!result.ok)return NextResponse.json({error:result.reason},{status:404});
    writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.restored",objectType:"product",objectId:id,ip:requestIp(request),metadata:{status:result.status,reason:result.reason}});
    return NextResponse.json(result);
  }

  const parsed = parseProductInput(body as Record<string, unknown>);
  if (!parsed.value) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    saveProduct(id, parsed.value);
    writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "product.updated", objectType: "product", objectId: id, ip: requestIp(request) });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "PRODUCT_NOT_FOUND") return NextResponse.json({ error: "商品不存在或已归档" }, { status: 404 });
    if(message==="WAREHOUSE_STATUS_MANAGED"||message==="WAREHOUSE_SKU_MANAGED")return NextResponse.json({error:message==="WAREHOUSE_STATUS_MANAGED"?"仓库同步商品状态由仓库管理":"仓库同步 SKU、价格和库存由仓库管理"},{status:409});
    return NextResponse.json({ error: message.includes("UNIQUE") ? "SKU 编码已被其他商品使用" : "商品保存失败" }, { status: message.includes("UNIQUE") ? 409 : 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const requested=new URL(request.url).searchParams.get("action");
  const action:ProductLifecycleAction=requested==="permanent-hide"?"permanent-hide":requested==="archive"?"archive":"auto";
  const decision=applyProductLifecycle(id,action);
  if(!decision.ok)return NextResponse.json({error:decision.reason},{status:404});
  if(decision.action!=="deleted"){
    writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:`product.${decision.action}`,objectType:"product",objectId:id,ip:requestIp(request),metadata:{reason:decision.reason}});
    return NextResponse.json({ok:true,action:decision.action,reason:decision.reason});
  }

  let cleanupPending = 0;
  for (const storageKey of decision.cleanupFiles || []) {
    try {
      await fs.unlink(path.join(uploadRoot, storageKey));
      db.prepare("DELETE FROM product_file_cleanup WHERE storage_key=?").run(storageKey);
    } catch (error) {
      cleanupPending += 1;
      db.prepare("UPDATE product_file_cleanup SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE storage_key=?").run(error instanceof Error ? error.message : "unlink_failed", storageKey);
    }
  }
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "product.deleted", objectType: "product", objectId: id, ip: requestIp(request), metadata: { permanent: true, cleanupPending } });
  return NextResponse.json({
    ok: true,
    action: decision.action,
    cleanupPending,
    reason: cleanupPending ? `商品记录已永久删除，${cleanupPending} 个图片文件等待后台清理` : "从未上架且没有订单引用，已永久删除",
  });
}
