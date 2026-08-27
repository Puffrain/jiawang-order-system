import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { uploadRoot } from "@/lib/product-catalog";
import { writeAudit } from "@/lib/audit";
import { requestIp } from "@/lib/security";

const MAX_SIZE=5*1024*1024;
const MAX_IMAGES=8;
const allowedExtensions:Record<string,string[]>={jpg:["jpg","jpeg"],png:["png"],webp:["webp"],gif:["gif"]};
function detect(bytes:Uint8Array){if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return{mime:"image/jpeg",ext:"jpg"};if(bytes.slice(0,8).every((value,index)=>value===[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][index]))return{mime:"image/png",ext:"png"};if(new TextDecoder().decode(bytes.slice(0,4))==="RIFF"&&new TextDecoder().decode(bytes.slice(8,12))==="WEBP")return{mime:"image/webp",ext:"webp"};if(/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0,6))))return{mime:"image/gif",ext:"gif"};return null;}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole("owner");if(auth.response)return auth.response;
  const{id}=await params;
  if(!db.prepare("SELECT id FROM products WHERE id=? AND archived_at IS NULL").get(id))return NextResponse.json({error:"商品不存在或已归档"},{status:404});
  const count=(db.prepare("SELECT COUNT(*) count FROM product_images WHERE product_id=?").get(id) as {count:number}).count;
  if(count>=MAX_IMAGES)return NextResponse.json({error:`每个商品最多 ${MAX_IMAGES} 张图片`},{status:409});
  const form=await request.formData().catch(()=>null);const file=form?.get("file");
  if(!(file instanceof File))return NextResponse.json({error:"请选择图片"},{status:400});
  if(file.size<1||file.size>MAX_SIZE)return NextResponse.json({error:"单张图片不能超过 5MB"},{status:413});
  const bytes=new Uint8Array(await file.arrayBuffer()),type=detect(bytes),originalExtension=file.name.split(".").pop()?.toLowerCase()||"";
  if(!type||!allowedExtensions[type.ext].includes(originalExtension))return NextResponse.json({error:"图片扩展名与真实格式不匹配，仅支持 JPG、PNG、WebP 或 GIF"},{status:415});
  const imageId=randomUUID(),storageKey=`${randomUUID()}.${type.ext}`,filePath=path.join(uploadRoot,storageKey);
  await fs.writeFile(filePath,bytes,{flag:"wx"});
  try{const isPrimary=count===0?1:0;db.prepare("INSERT INTO product_images(id,product_id,storage_key,mime_type,byte_size,sort_order,is_primary) VALUES(?,?,?,?,?,?,?)").run(imageId,id,storageKey,type.mime,file.size,count,isPrimary);writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.image.uploaded",objectType:"product",objectId:id,ip:requestIp(request),metadata:{imageId,byteSize:file.size,mimeType:type.mime}});return NextResponse.json({image:{id:imageId,url:`/api/product-images/${imageId}`,mimeType:type.mime,byteSize:file.size,sortOrder:count,isPrimary:Boolean(isPrimary)}},{status:201});}catch(error){await fs.unlink(filePath).catch(()=>{});throw error;}
}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireApiRole("owner");if(auth.response)return auth.response;const{id}=await params;
  const body=await request.json().catch(()=>({}));const orderedIds:string[]=Array.isArray(body.orderedIds)?body.orderedIds.map(String):[];
  const rows=db.prepare("SELECT id FROM product_images WHERE product_id=?").all(id) as Array<{id:string}>;
  if(rows.length!==orderedIds.length||new Set(orderedIds).size!==rows.length||rows.some(row=>!orderedIds.includes(row.id)))return NextResponse.json({error:"图片排序数据无效"},{status:400});
  const primaryId=body.primaryId?String(body.primaryId):(orderedIds[0]||null);if(primaryId&&!orderedIds.includes(primaryId))return NextResponse.json({error:"主图不属于当前商品"},{status:400});
  db.transaction(()=>{const update=db.prepare("UPDATE product_images SET sort_order=?,is_primary=? WHERE id=? AND product_id=?");orderedIds.forEach((imageId,index)=>update.run(index,imageId===primaryId?1:0,imageId,id));})();
  writeAudit({actorUserId:auth.session.userId,actorRole:"owner",action:"product.images.sorted",objectType:"product",objectId:id,ip:requestIp(request),metadata:{primaryId,count:orderedIds.length}});return NextResponse.json({ok:true});
}
