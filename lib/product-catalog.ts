import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "@/lib/db";
import { cleanText } from "@/lib/validation";

db.exec(`CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order);`);
const imageColumns = db.prepare("PRAGMA table_info(product_images)").all() as Array<{ name: string }>;
if (!imageColumns.some((column) => column.name === "warehouse_asset_id")) db.exec("ALTER TABLE product_images ADD COLUMN warehouse_asset_id TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_warehouse_asset ON product_images(warehouse_asset_id) WHERE warehouse_asset_id IS NOT NULL");

export const uploadRoot = path.resolve(process.cwd(), process.env.UPLOAD_DIR || "data/uploads");
fs.mkdirSync(uploadRoot, { recursive: true });

export type TierInput = { minQty: number; maxQty: number | null; unitPrice: number };
export type SkuInput = { id?: string; skuCode: string; specName: string; basePrice: number; stock: number; tiers: TierInput[] };
export type ProductInput = { name: string; category: string; categoryKey: string; subcategoryKey: string | null; brand: string; description: string; status: "active" | "inactive"; skus: SkuInput[] };
export type ProductLifecycleAction = "archive" | "permanent-hide" | "auto";
export type ProductLifecycleResult = { productId:string; ok:boolean; action:"archived"|"permanently-hidden"|"deleted"|"missing"; reason:string; cleanupPending?:number; cleanupFiles?:string[] };
export type ProductRestoreResult = { productId:string; ok:boolean; action:"restored"|"unchanged"|"missing"; reason:string; status?:"active"|"inactive" };

function amount(value: unknown, max = 100_000_000) { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= max ? Number(number.toFixed(2)) : null; }
function stock(value: unknown) { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 10_000_000 ? number : null; }
function catalogKey(value: unknown, fallback = "") { return cleanText(value, 100).normalize("NFKC").replace(/\s+/g, " ").toLowerCase() || fallback; }

export function parseProductInput(body: Record<string, unknown>): { value?: ProductInput; error?: string } {
  const name = cleanText(body.name, 120), category = cleanText(body.category, 60), brand = cleanText(body.brand, 60), description = cleanText(body.description, 3000);
  const status = body.status === "inactive" ? "inactive" : "active";
  if (!name || !category) return { error: "商品名称和分类不能为空" };
  const categoryKey=catalogKey(body.categoryKey,catalogKey(category));
  if(!categoryKey)return {error:"分类键无效"};
  if(body.subcategoryKey!==undefined&&body.subcategoryKey!==null&&typeof body.subcategoryKey!=="string")return {error:"子分类键无效"};
  const subcategoryKey=catalogKey(body.subcategoryKey);
  if (!Array.isArray(body.skus) || body.skus.length < 1 || body.skus.length > 50) return { error: "每个商品需要 1 至 50 个规格" };
  const codes = new Set<string>(); const skus: SkuInput[] = [];
  for (const raw of body.skus as Array<Record<string, unknown>>) {
    const skuCode = cleanText(raw.skuCode, 64).toUpperCase(), specName = cleanText(raw.specName, 100);
    const basePrice = amount(raw.basePrice), skuStock = stock(raw.stock);
    if (!/^[A-Z0-9._/-]{2,64}$/.test(skuCode) || !specName || basePrice === null || skuStock === null) return { error: "规格编码、名称、价格或库存无效" };
    if (codes.has(skuCode)) return { error: `规格编码重复：${skuCode}` }; codes.add(skuCode);
    const rawTiers = Array.isArray(raw.tiers) ? raw.tiers : [];
    const tiers = rawTiers.map(item => { const tier = item as Record<string, unknown>; return { minQty: stock(tier.minQty), maxQty: tier.maxQty === null || tier.maxQty === "" || tier.maxQty === undefined ? null : stock(tier.maxQty), unitPrice: amount(tier.unitPrice) }; });
    if (tiers.some(tier => !tier.minQty || tier.unitPrice === null || (tier.maxQty !== null && tier.maxQty < tier.minQty))) return { error: `规格 ${skuCode} 的阶梯价无效` };
    tiers.sort((a,b) => Number(a.minQty)-Number(b.minQty));
    for (let index=1; index<tiers.length; index++) if (tiers[index-1].maxQty === null || Number(tiers[index].minQty) <= Number(tiers[index-1].maxQty)) return { error: `规格 ${skuCode} 的阶梯区间重叠` };
    skus.push({ id: typeof raw.id === "string" ? raw.id : undefined, skuCode, specName, basePrice, stock: skuStock, tiers: tiers as TierInput[] });
  }
  return { value: { name, category, categoryKey, subcategoryKey:subcategoryKey||null, brand, description, status, skus } };
}

export function saveProduct(productId: string | null, input: ProductInput) {
  return db.transaction(() => {
    const id = productId || randomUUID();
    const sourceProduct = productId ? db.prepare("SELECT name,category,brand,status,warehouse_product_id warehouseProductId FROM products WHERE id=? AND archived_at IS NULL AND permanently_hidden_at IS NULL").get(id) as { name:string;category:string;brand:string|null;status:"active"|"inactive";warehouseProductId:string|null } | undefined : undefined;
    if (productId) {
      if (!sourceProduct) throw new Error("PRODUCT_NOT_FOUND");
      if (sourceProduct.warehouseProductId) {
        if (input.status !== sourceProduct.status) throw new Error("WAREHOUSE_STATUS_MANAGED");
        db.prepare("UPDATE products SET description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(input.description||null,id);
      }
      else db.prepare("UPDATE products SET name=?,category=?,category_key=?,subcategory_key=?,brand=?,description=?,status=?,first_activated_at=CASE WHEN ?='active' THEN COALESCE(first_activated_at,CURRENT_TIMESTAMP) ELSE first_activated_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(input.name,input.category,input.categoryKey,input.subcategoryKey,input.brand||null,input.description||null,input.status,input.status,id);
    } else db.prepare("INSERT INTO products(id,name,category,category_key,subcategory_key,brand,description,status,first_activated_at) VALUES(?,?,?,?,?,?,?,?,CASE WHEN ?='active' THEN CURRENT_TIMESTAMP END)").run(id,input.name,input.category,input.categoryKey,input.subcategoryKey,input.brand||null,input.description||null,input.status,input.status);
    const activeIds = new Set<string>();
    for (const sku of input.skus) {
      let skuId = sku.id;
      if (skuId) {
        const owned = db.prepare("SELECT id,warehouse_variant_id warehouseVariantId FROM product_skus WHERE id=? AND product_id=? AND archived_at IS NULL").get(skuId,id) as { id: string; warehouseVariantId: string | null } | undefined;
        if (!owned) throw new Error("SKU_NOT_FOUND");
        if (owned.warehouseVariantId) {
          const current = db.prepare("SELECT sku_code skuCode,spec_name specName,COALESCE(sale_price_override,warehouse_base_price,base_price) basePrice,stock FROM product_skus WHERE id=?").get(skuId) as {skuCode:string;specName:string;basePrice:number;stock:number};
          if (sku.skuCode !== current.skuCode || sku.specName !== current.specName || sku.basePrice !== current.basePrice || sku.stock !== current.stock) throw new Error("WAREHOUSE_SKU_MANAGED");
        }
        else db.prepare("UPDATE product_skus SET sku_code=?,spec_name=?,base_price=?,stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(sku.skuCode,sku.specName,sku.basePrice,sku.stock,skuId);
      } else {
        if (sourceProduct?.warehouseProductId) throw new Error("WAREHOUSE_SKU_MANAGED");
        skuId=randomUUID(); db.prepare("INSERT INTO product_skus(id,product_id,sku_code,spec_name,base_price,stock) VALUES(?,?,?,?,?,?)").run(skuId,id,sku.skuCode,sku.specName,sku.basePrice,sku.stock);
      }
      if (!skuId) throw new Error("SKU_NOT_FOUND");
      activeIds.add(skuId); db.prepare("DELETE FROM tier_prices WHERE sku_id=?").run(skuId);
      const insertTier=db.prepare("INSERT INTO tier_prices(sku_id,min_qty,max_qty,unit_price) VALUES(?,?,?,?)"); for(const tier of sku.tiers) insertTier.run(skuId,tier.minQty,tier.maxQty,tier.unitPrice);
    }
    if (productId) {
      const existingIds=db.prepare("SELECT id,warehouse_variant_id warehouseVariantId FROM product_skus WHERE product_id=? AND archived_at IS NULL").all(id) as Array<{id:string;warehouseVariantId:string|null}>;
      for(const row of existingIds) {
        if (row.warehouseVariantId && !activeIds.has(row.id)) throw new Error("WAREHOUSE_SKU_MANAGED");
        if(!activeIds.has(row.id)) db.prepare("UPDATE product_skus SET archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      }
    }
    return id;
  })();
}

export type ProductListScope = "all" | "active" | "archived";
type ProductImage = { id:string; mimeType:string; byteSize:number; sortOrder:number; isPrimary:number; url:string };
type CatalogSku = { id:string; skuCode:string; specName:string; legacyBasePrice:number; warehouseBasePrice:number|null; salePriceOverride:number|null; campaignPrice:number|null; campaignStartsAt:string|null; campaignEndsAt:string|null; campaignPaused:number; campaignActive:boolean; regularPrice:number; basePrice:number; stock:number; warehouseVariantId:string|null; archivedAt:string|null; tiers:TierInput[] };
export type CatalogProduct = {
  id:string; name:string; category:string; categoryKey:string; subcategoryKey:string|null; brand:string|null; description:string|null; status:"active"|"inactive";
  warehouseProductId:string|null; warehouseRevision:number|null; warehouseMediaRevision:number|null; warehouseSaleStatus:string|null; archivedAt:string|null; permanentlyHiddenAt:string|null; statusBeforeArchive:string|null; createdAt:string; updatedAt:string;
  archived:boolean; permanentlyHidden:boolean; images:ProductImage[]; primaryImage:ProductImage|null; skus:CatalogSku[]; totalStock:number; salesCount:number; recommendations:Array<{recommendedProductId:string}>; recommendationIds:string[];
};

function listWhere(role:"owner"|"buyer", scope:ProductListScope) {
  if(role==="buyer")return "WHERE p.status='active' AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL";
  if(scope==="active")return "WHERE p.status='active' AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL";
  if(scope==="archived")return "WHERE p.archived_at IS NOT NULL";
  return "";
}

export function listProducts(role: "owner" | "buyer", options:{scope?:ProductListScope}={}) : CatalogProduct[] {
  const scope=options.scope||"all";
  const products=db.prepare(`SELECT p.id,p.name,p.category,COALESCE(NULLIF(p.category_key,''),lower(trim(p.category))) categoryKey,p.subcategory_key subcategoryKey,p.brand,p.description,p.status,
    p.warehouse_product_id warehouseProductId,p.warehouse_revision warehouseRevision,p.warehouse_media_revision warehouseMediaRevision,p.warehouse_sale_status warehouseSaleStatus,
    p.archived_at archivedAt,p.permanently_hidden_at permanentlyHiddenAt,p.status_before_archive statusBeforeArchive,p.created_at createdAt,p.updated_at updatedAt,
    COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE oi.sku_id IN (SELECT id FROM product_skus WHERE product_id=p.id) AND o.payment_status='paid' AND o.refunded_at IS NULL AND o.deleted_at IS NULL),0) salesCount
    FROM products p ${listWhere(role,scope)} ORDER BY p.updated_at DESC,p.id`).all() as Array<Omit<CatalogProduct,"archived"|"permanentlyHidden"|"images"|"primaryImage"|"skus"|"totalStock"|"recommendations"|"recommendationIds">>;
  const imageStmt=db.prepare("SELECT id,mime_type mimeType,byte_size byteSize,sort_order sortOrder,is_primary isPrimary FROM product_images WHERE product_id=? ORDER BY sort_order,id");
  const skuStmt=db.prepare(`SELECT id,sku_code skuCode,spec_name specName,base_price legacyBasePrice,warehouse_base_price warehouseBasePrice,sale_price_override salePriceOverride,
    campaign_price campaignPrice,campaign_starts_at campaignStartsAt,campaign_ends_at campaignEndsAt,campaign_paused campaignPaused,
    COALESCE(sale_price_override,warehouse_base_price,base_price) regularPrice,
    CASE WHEN campaign_price IS NOT NULL AND campaign_paused=0 AND datetime('now')>=datetime(campaign_starts_at) AND datetime('now')<datetime(campaign_ends_at)
      THEN campaign_price ELSE COALESCE(sale_price_override,warehouse_base_price,base_price) END basePrice,
    CASE WHEN campaign_price IS NOT NULL AND campaign_paused=0 AND datetime('now')>=datetime(campaign_starts_at) AND datetime('now')<datetime(campaign_ends_at) THEN 1 ELSE 0 END campaignActive,
    stock,warehouse_variant_id warehouseVariantId,archived_at archivedAt
    FROM product_skus WHERE product_id=? ${role==="buyer"?"AND archived_at IS NULL":""} ORDER BY created_at,id`);
  const tierStmt=db.prepare("SELECT min_qty minQty,max_qty maxQty,unit_price unitPrice FROM tier_prices WHERE sku_id=? ORDER BY min_qty");
  const recommendationStmt=db.prepare(`SELECT r.recommended_product_id recommendedProductId FROM product_recommendations r JOIN products p ON p.id=r.recommended_product_id
    WHERE r.product_id=? ${role==="buyer"?"AND p.status='active' AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL":""} ORDER BY r.sort_order,r.created_at,r.recommended_product_id`);
  return products.map(product=>{
    const skuRows=skuStmt.all(product.id) as Array<Omit<CatalogSku,"tiers">>;
    const skus=skuRows.map(sku=>({...sku,tiers:tierStmt.all(sku.id) as TierInput[]}));
    const imageRows=imageStmt.all(product.id) as Array<Omit<ProductImage,"url">>;
    const images=imageRows.map(image=>({...image,url:`/api/product-images/${image.id}`}));
    const recommendations=recommendationStmt.all(product.id) as Array<{recommendedProductId:string}>;
    return {...product,archived:Boolean(product.archivedAt),permanentlyHidden:Boolean(product.permanentlyHiddenAt),images,primaryImage:images.find(image=>Boolean(image.isPrimary))||images[0]||null,skus,totalStock:skus.reduce((sum,sku)=>sum+Number(sku.stock),0),salesCount:Number(product.salesCount)||0,recommendations,recommendationIds:recommendations.map(item=>item.recommendedProductId)};
  });
}

function isBuyerVisible(product:CatalogProduct) {
  return product.status==="active"&&!product.archived&&!product.permanentlyHidden&&product.skus.length>0;
}

export function getProductDetail(productId:string, role:"owner"|"buyer") {
  const products=listProducts(role,{scope:role==="buyer"?"active":"all"});
  const product=products.find(item=>item.id===productId);
  if(!product)return null;
  const activeProducts=products.filter(isBuyerVisible);
  const byId=new Map(activeProducts.map(item=>[item.id,item]));
  const recommendations=product.recommendationIds.flatMap(id=>{const item=byId.get(id);return item?[item]:[]}).slice(0,6);
  const recommendationIds=new Set(recommendations.map(item=>item.id));
  const relatedCandidates=activeProducts.filter(item=>item.id!==product.id&&!recommendationIds.has(item.id)&&item.categoryKey===product.categoryKey);
  const relatedProducts=relatedCandidates.sort((left,right)=>{
    const leftSameSubcategory=Boolean(product.subcategoryKey&&left.subcategoryKey===product.subcategoryKey);
    const rightSameSubcategory=Boolean(product.subcategoryKey&&right.subcategoryKey===product.subcategoryKey);
    if(leftSameSubcategory!==rightSameSubcategory)return leftSameSubcategory?-1:1;
    return String(right.updatedAt).localeCompare(String(left.updatedAt))||left.id.localeCompare(right.id);
  }).slice(0,8);
  return {...product,recommendations,relatedProducts};
}

export function getProductRecommendationConfig(productId:string) {
  const product=getProductDetail(productId,"owner");
  if(!product||product.archived||product.permanentlyHidden)return null;
  return {product,candidates:listProducts("owner",{scope:"active"}).filter(item=>item.id!==productId&&isBuyerVisible(item))};
}

export function setProductRecommendations(productId:string, recommendedProductIds:string[]) {
  const ids=[...new Set(recommendedProductIds.map(id=>cleanText(id,100)).filter(Boolean))];
  if(ids.length>6||ids.includes(productId))throw new Error("INVALID_RECOMMENDATIONS");
  return db.transaction(()=>{
    if(!db.prepare("SELECT id FROM products WHERE id=? AND archived_at IS NULL AND permanently_hidden_at IS NULL").get(productId))throw new Error("PRODUCT_NOT_FOUND");
    if(ids.length){
      const placeholders=ids.map(()=>"?").join(",");
      const count=(db.prepare(`SELECT COUNT(*) count FROM products p WHERE p.id IN (${placeholders}) AND p.status='active' AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL AND EXISTS (SELECT 1 FROM product_skus s WHERE s.product_id=p.id AND s.archived_at IS NULL)`).get(...ids) as {count:number}).count;
      if(count!==ids.length)throw new Error("INVALID_RECOMMENDATIONS");
    }
    db.prepare("DELETE FROM product_recommendations WHERE product_id=?").run(productId);
    const insert=db.prepare("INSERT INTO product_recommendations(product_id,recommended_product_id,sort_order) VALUES(?,?,?)");
    ids.forEach((recommendedId,index)=>insert.run(productId,recommendedId,index));
    return ids;
  })();
}

export function applyProductLifecycle(productId:string, action:ProductLifecycleAction):ProductLifecycleResult {
  return db.transaction(()=>{
    const product=db.prepare("SELECT status,warehouse_product_id warehouseProductId,first_activated_at firstActivatedAt,archived_at archivedAt,permanently_hidden_at permanentlyHiddenAt FROM products WHERE id=?").get(productId) as {status:string;warehouseProductId:string|null;firstActivatedAt:string|null;archivedAt:string|null;permanentlyHiddenAt:string|null}|undefined;
    if(!product)return {productId,ok:false,action:"missing" as const,reason:"商品不存在"};
    const orderCount=(db.prepare("SELECT COUNT(*) count FROM order_items WHERE sku_id IN (SELECT id FROM product_skus WHERE product_id=?)").get(productId) as {count:number}).count;
    const canDelete=action==="auto"&&product.status==="inactive"&&!product.warehouseProductId&&!product.firstActivatedAt&&orderCount===0;
    if(canDelete){
      const files=(db.prepare("SELECT storage_key storageKey FROM product_images WHERE product_id=?").all(productId) as Array<{storageKey:string}>).map(item=>item.storageKey);
      const enqueue=db.prepare("INSERT OR IGNORE INTO product_file_cleanup(storage_key,product_id) VALUES(?,?)");
      files.forEach(storageKey=>enqueue.run(storageKey,productId));
      db.prepare("DELETE FROM cart_items WHERE sku_id IN (SELECT id FROM product_skus WHERE product_id=?)").run(productId);
      db.prepare("DELETE FROM products WHERE id=?").run(productId);
      return {productId,ok:true,action:"deleted" as const,reason:"从未上架且没有订单引用，已永久删除",cleanupFiles:files,cleanupPending:files.length};
    }
    // Deleting from the archive page means "remove from management forever".
    // Only safe local drafts are physically deleted; every protected record is hidden.
    const permanent=action==="permanent-hide"||(action==="auto"&&Boolean(product.archivedAt));
    if(permanent&&product.permanentlyHiddenAt)return {productId,ok:true,action:"permanently-hidden" as const,reason:"商品已永久隐藏"};
    if(!permanent&&product.archivedAt&&!product.permanentlyHiddenAt)return {productId,ok:true,action:"archived" as const,reason:"商品已归档"};
    db.prepare(`UPDATE products SET status='inactive',archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP),
      status_before_archive=CASE WHEN archived_at IS NULL THEN status ELSE status_before_archive END,
      permanently_hidden_at=CASE WHEN ? THEN COALESCE(permanently_hidden_at,CURRENT_TIMESTAMP) ELSE permanently_hidden_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(permanent?1:0,productId);
    db.prepare(`UPDATE product_skus SET archived_by_product=CASE WHEN archived_at IS NULL THEN 1 ELSE archived_by_product END,
      archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE product_id=?`).run(productId);
    const reason=permanent?"商品已永久隐藏，后续仓库同步不会恢复展示":product.warehouseProductId?"仓库同步商品已归档并保留同步关系":product.firstActivatedAt?"商品曾经上架，已归档保留历史":orderCount?"商品已被订单引用，已归档保留历史":"商品已归档";
    return {productId,ok:true,action:permanent?"permanently-hidden" as const:"archived" as const,reason};
  }).immediate();
}

export function restoreProduct(productId:string):ProductRestoreResult {
  return db.transaction(()=>{
    const product=db.prepare(`SELECT status,status_before_archive statusBeforeArchive,warehouse_product_id warehouseProductId,warehouse_sale_status warehouseSaleStatus,
      archived_at archivedAt,permanently_hidden_at permanentlyHiddenAt FROM products WHERE id=?`).get(productId) as {status:"active"|"inactive";statusBeforeArchive:"active"|"inactive"|null;warehouseProductId:string|null;warehouseSaleStatus:string|null;archivedAt:string|null;permanentlyHiddenAt:string|null}|undefined;
    if(!product)return {productId,ok:false,action:"missing" as const,reason:"商品不存在"};
    if(!product.archivedAt&&!product.permanentlyHiddenAt)return {productId,ok:true,action:"unchanged" as const,status:product.status,reason:"商品未归档"};
    const status=product.warehouseProductId?(product.warehouseSaleStatus==="active"?"active":"inactive"):(product.statusBeforeArchive||product.status);
    db.prepare(`UPDATE products SET status=?,archived_at=NULL,permanently_hidden_at=NULL,status_before_archive=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status,productId);
    db.prepare(`UPDATE product_skus SET archived_at=NULL,archived_by_product=0,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND archived_by_product=1`).run(productId);
    return {productId,ok:true,action:"restored" as const,status,reason:status==="active"?"商品已恢复在线销售":"商品已恢复为下架状态"};
  }).immediate();
}

export type WarehouseSkuPrice = { id:string; productId:string; skuCode:string; warehouseVariantId:string; warehouseBasePrice:number|null; salePriceOverride:number|null; basePrice:number };

export function getWarehouseSkuPrice(productId:string, skuId:string):WarehouseSkuPrice|null {
  return db.prepare(`SELECT s.id,s.product_id productId,s.sku_code skuCode,s.warehouse_variant_id warehouseVariantId,s.warehouse_base_price warehouseBasePrice,
    s.sale_price_override salePriceOverride,COALESCE(s.sale_price_override,s.warehouse_base_price,s.base_price) basePrice
    FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=? AND s.product_id=? AND s.warehouse_variant_id IS NOT NULL`).get(skuId,productId) as WarehouseSkuPrice|undefined||null;
}

export function setWarehouseSkuPriceOverride(productId:string, skuId:string, rawOverride:unknown):WarehouseSkuPrice {
  const salePriceOverride=rawOverride===null?null:amount(rawOverride);
  if(rawOverride!==null&&salePriceOverride===null)throw new Error("INVALID_SALE_PRICE_OVERRIDE");
  return db.transaction(()=>{
    const product=db.prepare(`SELECT s.id FROM product_skus s JOIN products p ON p.id=s.product_id
      WHERE s.id=? AND s.product_id=? AND s.warehouse_variant_id IS NOT NULL AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL`).get(skuId,productId) as {id:string}|undefined;
    if(!product)throw new Error("WAREHOUSE_SKU_NOT_FOUND");
    db.prepare("UPDATE product_skus SET sale_price_override=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(salePriceOverride,skuId);
    const result=getWarehouseSkuPrice(productId,skuId);
    if(!result)throw new Error("WAREHOUSE_SKU_NOT_FOUND");
    return result;
  }).immediate();
}

export function setSkuCampaign(productId:string,skuId:string,input:{price?:unknown;startsAt?:unknown;endsAt?:unknown;paused?:unknown}){
  const price=amount(input.price),startsAt=typeof input.startsAt==="string"?new Date(input.startsAt):null,endsAt=typeof input.endsAt==="string"?new Date(input.endsAt):null;
  if(price===null||!startsAt||!endsAt||!Number.isFinite(startsAt.getTime())||!Number.isFinite(endsAt.getTime())||endsAt<=startsAt)throw new Error("INVALID_CAMPAIGN");
  return db.transaction(()=>{
    const sku=db.prepare(`SELECT COALESCE(s.sale_price_override,s.warehouse_base_price,s.base_price) regularPrice FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=? AND s.product_id=? AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL`).get(skuId,productId) as {regularPrice:number}|undefined;
    if(!sku)throw new Error("SKU_NOT_FOUND");
    if(price>Number(sku.regularPrice))throw new Error("CAMPAIGN_ABOVE_REGULAR");
    db.prepare("UPDATE product_skus SET campaign_price=?,campaign_starts_at=?,campaign_ends_at=?,campaign_paused=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(price,startsAt.toISOString(),endsAt.toISOString(),input.paused?1:0,skuId);
    return{campaignPrice:price,campaignStartsAt:startsAt.toISOString(),campaignEndsAt:endsAt.toISOString(),campaignPaused:input.paused?1:0,regularPrice:Number(sku.regularPrice)};
  }).immediate();
}

export function clearSkuCampaign(productId:string,skuId:string){
  const result=db.prepare(`UPDATE product_skus SET campaign_price=NULL,campaign_starts_at=NULL,campaign_ends_at=NULL,campaign_paused=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND product_id=?`).run(skuId,productId);
  if(!result.changes)throw new Error("SKU_NOT_FOUND");
}
