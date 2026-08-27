import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { applyProductLifecycle, listProducts, parseProductInput, saveProduct, type ProductLifecycleAction } from "@/lib/product-catalog";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
import { refreshWarehouseStock } from "@/lib/warehouse-inventory";

export async function GET() {
  const auth=await requireApiRole(); if(auth.response)return auth.response;
  try { await refreshWarehouseStock(); } catch { /* serve the last warehouse snapshot during a brief outage */ }
  return NextResponse.json({products:listProducts(auth.session.role)},{headers:{"Cache-Control":"no-store"}});
}

export async function DELETE(request:Request) {
  const auth=await requireApiRole("owner"); if(auth.response)return auth.response;
  const body=await request.json().catch(()=>({})) as {productIds?:unknown;action?:unknown};
  const productIds:string[]=Array.isArray(body.productIds)?[...new Set(body.productIds.map((value:unknown)=>String(value)).filter(Boolean))]:[];
  const action:ProductLifecycleAction=body.action==="permanent-hide"?"permanent-hide":body.action==="archive"?"archive":"auto";
  if(!productIds.length||productIds.length>100)return NextResponse.json({error:"商品列表无效"},{status:400});
  const results=productIds.map(productId=>applyProductLifecycle(productId,action));
  for(const result of results)writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:`product.${result.action}`,objectType:"product",objectId:result.productId,ip:requestIp(request),metadata:{ok:result.ok,reason:result.reason}});
  return NextResponse.json({ok:results.every(result=>result.ok),results},{status:results.some(result=>result.ok)?200:404});
}

export async function POST(request:Request) {
  const auth=await requireApiRole("owner"); if(auth.response)return auth.response;
  const body=await request.json().catch(()=>null); if(!body||typeof body!=="object")return NextResponse.json({error:"商品数据无效"},{status:400});
  const parsed=parseProductInput(body as Record<string,unknown>); if(!parsed.value)return NextResponse.json({error:parsed.error},{status:400});
  try { const id=saveProduct(null,parsed.value); writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.created",objectType:"product",objectId:id,ip:requestIp(request)}); return NextResponse.json({id},{status:201}); }
  catch(error){const message=error instanceof Error?error.message:"";return NextResponse.json({error:message.includes("UNIQUE")?"SKU 编码已被其他商品使用":"商品保存失败"},{status:message.includes("UNIQUE")?409:500});}
}
