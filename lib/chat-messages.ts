import db from "@/lib/db";

export type ChatMessageType = "text" | "image" | "product";

export function activeBuyer(buyerUserId: string) {
  return db.prepare("SELECT id FROM users WHERE id=? AND role='buyer' AND status='active'").get(buyerUserId) as { id: string } | undefined;
}

export function insertChatMessage(input: {
  fromUserId: string;
  toUserId: string;
  buyerUserId: string;
  type: ChatMessageType;
  content: string;
  payload?: Record<string, unknown>;
  eventKey: string;
}) {
  return db.transaction(() => {
    const result = db.prepare("INSERT OR IGNORE INTO im_message(from_user_id,to_user_id,msg_type,content,payload_json,event_key) VALUES(?,?,?,?,?,?)").run(
      input.fromUserId, input.toUserId, input.type, input.content, input.payload ? JSON.stringify(input.payload) : null, input.eventKey,
    );
    if (!result.changes) {
      const existing = db.prepare("SELECT id FROM im_message WHERE event_key=?").get(input.eventKey) as { id: number };
      return { id: existing.id, replayed: true };
    }
    const id = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO im_conversation(user_id,target_id,last_msg,unread_count,owner_hidden_at) VALUES(?,?,?,0,NULL)
      ON CONFLICT(user_id,target_id) DO UPDATE SET last_msg=excluded.last_msg,owner_hidden_at=NULL,updated_at=CURRENT_TIMESTAMP`).run(input.fromUserId,input.toUserId,input.content);
    db.prepare(`INSERT INTO im_conversation(user_id,target_id,last_msg,unread_count,owner_hidden_at) VALUES(?,?,?,1,NULL)
      ON CONFLICT(user_id,target_id) DO UPDATE SET last_msg=excluded.last_msg,unread_count=im_conversation.unread_count+1,owner_hidden_at=NULL,updated_at=CURRENT_TIMESTAMP`).run(input.toUserId,input.fromUserId,input.content);
    return { id, replayed: false };
  })();
}

export function productSnapshot(productId: string) {
  const product = db.prepare(`SELECT id,name,category,brand,description FROM products
    WHERE id=? AND status='active' AND archived_at IS NULL AND permanently_hidden_at IS NULL`).get(productId) as { id: string; name: string; category: string; brand: string | null; description: string | null } | undefined;
  if (!product) return null;
  const skus = db.prepare(`SELECT id,sku_code skuCode,spec_name specName,COALESCE(sale_price_override,warehouse_base_price,base_price) basePrice,stock
    FROM product_skus WHERE product_id=? AND archived_at IS NULL ORDER BY created_at`).all(productId);
  const prices = (skus as Array<{ id: string; basePrice: number }>).flatMap(sku => {
    const tiers = db.prepare("SELECT unit_price unitPrice FROM tier_prices WHERE sku_id=?").all(sku.id) as Array<{ unitPrice: number }>;
    return [Number(sku.basePrice), ...tiers.map(tier => Number(tier.unitPrice))];
  });
  let primaryImageId: string | null = null;
  try {
    primaryImageId = (db.prepare("SELECT id FROM product_images WHERE product_id=? ORDER BY is_primary DESC,sort_order,id LIMIT 1").get(productId) as { id: string } | undefined)?.id || null;
  } catch {
    // Older databases may not have initialized product media yet.
  }
  return { ...product, status: "active", price: prices.length ? Math.min(...prices) : null, skus, primaryImageId, imageUrl: primaryImageId ? `/api/product-images/${primaryImageId}` : null };
}
