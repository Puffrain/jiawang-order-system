import db from "@/lib/db";
import "@/lib/product-catalog";

export type PricedLine = { skuId: string; skuCode: string; productName: string; specName: string; quantity: number; listPrice: number; unitPrice: number; lineTotal: number; stock: number };

export function priceSku(skuId: string, quantity: number): PricedLine | null {
  const sku = db.prepare(`SELECT s.id,s.sku_code AS skuCode,s.spec_name AS specName,
    CASE WHEN s.campaign_price IS NOT NULL AND s.campaign_paused=0
      AND datetime('now')>=datetime(s.campaign_starts_at) AND datetime('now')<datetime(s.campaign_ends_at)
      THEN s.campaign_price ELSE COALESCE(s.sale_price_override,s.warehouse_base_price,s.base_price) END AS listPrice,
    s.stock,p.name AS productName
    FROM product_skus s JOIN products p ON p.id=s.product_id
    WHERE s.id=? AND s.archived_at IS NULL AND p.status='active' AND p.archived_at IS NULL AND p.permanently_hidden_at IS NULL`)
    .get(skuId) as { id:string; skuCode:string; specName:string; listPrice:number; stock:number; productName:string } | undefined;
  if (!sku || quantity < 1 || quantity > sku.stock) return null;
  const tier = db.prepare(`SELECT unit_price AS unitPrice FROM tier_prices WHERE sku_id=? AND min_qty<=? AND (max_qty IS NULL OR max_qty>=?) ORDER BY min_qty DESC LIMIT 1`).get(skuId, quantity, quantity) as { unitPrice:number } | undefined;
  const unitPrice = tier?.unitPrice ?? sku.listPrice;
  return { skuId, skuCode:sku.skuCode, productName:sku.productName, specName:sku.specName, quantity, listPrice:sku.listPrice, unitPrice, lineTotal:Number((unitPrice*quantity).toFixed(2)), stock:sku.stock };
}
