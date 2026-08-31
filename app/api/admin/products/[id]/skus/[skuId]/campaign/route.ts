import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { clearSkuCampaign,setSkuCampaign } from "@/lib/product-catalog";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";
type Context={params:Promise<{id:string;skuId:string}>};
export async function PUT(request:Request,{params}:Context){const auth=await requireApiRole("owner");if(auth.response)return auth.response;const{id,skuId}=await params,body=await request.json().catch(()=>null);try{const campaign=setSkuCampaign(id,skuId,body||{});writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.campaign.updated",objectType:"product_sku",objectId:skuId,ip:requestIp(request),metadata:{productId:id,...campaign}});return NextResponse.json({ok:true,campaign})}catch(error){const code=error instanceof Error?error.message:"";return NextResponse.json({error:code==="CAMPAIGN_ABOVE_REGULAR"?"活动价不能高于原价":code==="SKU_NOT_FOUND"?"商品规格不存在":"活动价格或时间无效"},{status:code==="SKU_NOT_FOUND"?404:400})}}
export async function DELETE(request:Request,{params}:Context){const auth=await requireApiRole("owner");if(auth.response)return auth.response;const{id,skuId}=await params;try{clearSkuCampaign(id,skuId);writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.campaign.cleared",objectType:"product_sku",objectId:skuId,ip:requestIp(request),metadata:{productId:id}});return NextResponse.json({ok:true})}catch{return NextResponse.json({error:"商品规格不存在"},{status:404})}}
