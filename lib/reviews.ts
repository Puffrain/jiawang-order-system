import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { cleanText } from "@/lib/validation";

type ReviewRow = { id:string; orderId:string; orderItemId:string; productId:string; buyerUserId:string; buyerName:string; rating:number; content:string; status:string; merchantReply:string|null; merchantRepliedAt:string|null; createdAt:string; hiddenAt:string|null };

function mapReview(row:Record<string, unknown>):ReviewRow {
  return { id:String(row.id), orderId:String(row.orderId), orderItemId:String(row.orderItemId), productId:String(row.productId), buyerUserId:String(row.buyerUserId), buyerName:String(row.buyerName || "买家"), rating:Number(row.rating), content:String(row.content), status:String(row.status), merchantReply:row.merchantReply == null ? null : String(row.merchantReply), merchantRepliedAt:row.merchantRepliedAt == null ? null : String(row.merchantRepliedAt), createdAt:String(row.createdAt), hiddenAt:row.hiddenAt == null ? null : String(row.hiddenAt) };
}

const reviewSelect = `SELECT r.id,r.order_id orderId,r.order_item_id orderItemId,r.product_id productId,r.buyer_user_id buyerUserId,
  u.display_name buyerName,r.rating,r.content,r.status,r.merchant_reply merchantReply,r.merchant_replied_at merchantRepliedAt,
  r.created_at createdAt,r.hidden_at hiddenAt FROM product_reviews r JOIN users u ON u.id=r.buyer_user_id`;

export function getProductReviewSummary(productId:string, includeHidden = false) {
  const where = includeHidden ? "WHERE r.product_id=?" : "WHERE r.product_id=? AND r.status='published'";
  const stats = db.prepare(`SELECT COUNT(*) count,COALESCE(AVG(r.rating),0) average FROM product_reviews r ${where}`).get(productId) as {count:number;average:number};
  const rows = db.prepare(`${reviewSelect} ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT 20`).all(productId) as Record<string,unknown>[];
  return { count:Number(stats.count)||0, average:Number(Number(stats.average||0).toFixed(1)), reviews:rows.map(mapReview) };
}

export function getOrderReviews(orderId:string, includeHidden = true) {
  const where = includeHidden ? "WHERE r.order_id=?" : "WHERE r.order_id=? AND r.status='published'";
  return (db.prepare(`SELECT r.id,r.order_id orderId,r.order_item_id orderItemId,r.product_id productId,r.buyer_user_id buyerUserId,u.display_name buyerName,r.rating,r.content,r.status,r.merchant_reply merchantReply,r.merchant_replied_at merchantRepliedAt,r.created_at createdAt,r.hidden_at hiddenAt,oi.product_name productName FROM product_reviews r JOIN users u ON u.id=r.buyer_user_id JOIN order_items oi ON oi.id=r.order_item_id ${where} ORDER BY oi.id`).all(orderId) as Record<string,unknown>[]).map(row => ({...mapReview(row), productName: String(row.productName || "")}));
}

export function createReview(input:{orderId:string;orderItemId:string;buyerUserId:string;rating:number;content:string}) {
  const rating=Number(input.rating), content=cleanText(input.content,1000);
  if(!Number.isInteger(rating)||rating<1||rating>5) throw new Error("RATING_INVALID");
  if(!content) throw new Error("CONTENT_REQUIRED");
  const order=db.prepare(`SELECT o.id,o.status,o.payment_status paymentStatus,o.buyer_user_id buyerUserId,s.product_id productId
    FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN product_skus s ON s.id=oi.sku_id JOIN products p ON p.id=s.product_id
    WHERE o.id=? AND oi.id=?`).get(input.orderId,input.orderItemId) as {id:string;status:string;paymentStatus:string;buyerUserId:string;productId:string}|undefined;
  if(!order||order.buyerUserId!==input.buyerUserId) throw new Error("REVIEW_FORBIDDEN");
  if(order.status!=="closed"||order.paymentStatus!=="paid") throw new Error("REVIEW_NOT_ELIGIBLE");
  try { db.prepare(`INSERT INTO product_reviews(id,order_id,order_item_id,product_id,buyer_user_id,rating,content) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),input.orderId,input.orderItemId,order.productId,input.buyerUserId,rating,content); } catch(error) { if(String(error).includes("UNIQUE")) throw new Error("REVIEW_EXISTS"); throw error; }
  return db.prepare(`SELECT r.id,r.order_id orderId,r.order_item_id orderItemId,r.product_id productId,r.buyer_user_id buyerUserId,u.display_name buyerName,r.rating,r.content,r.status,r.merchant_reply merchantReply,r.merchant_replied_at merchantRepliedAt,r.created_at createdAt,r.hidden_at hiddenAt FROM product_reviews r JOIN users u ON u.id=r.buyer_user_id WHERE r.order_id=? AND r.order_item_id=?`).get(input.orderId,input.orderItemId) as Record<string,unknown>;
}

export function updateReview(id:string, action:"reply"|"hide"|"restore", value?:string, actorUserId?:string) {
  const review=db.prepare("SELECT id,merchant_reply merchantReply FROM product_reviews WHERE id=?").get(id) as {id:string;merchantReply:string|null}|undefined;
  if(!review) throw new Error("REVIEW_NOT_FOUND");
  if(action==="reply") { const reply=cleanText(value,1000); if(!reply) throw new Error("REPLY_REQUIRED"); if(review.merchantReply) throw new Error("REPLY_EXISTS"); db.prepare("UPDATE product_reviews SET merchant_reply=?,merchant_replied_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(reply,id); }
  if(action==="hide") db.prepare("UPDATE product_reviews SET status='hidden',hidden_at=CURRENT_TIMESTAMP,hidden_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(actorUserId||null,id);
  if(action==="restore") db.prepare("UPDATE product_reviews SET status='published',hidden_at=NULL,hidden_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
}

export function listAdminReviews(query:string, rating:string) {
  const clauses:string[]=[]; const args:unknown[]=[];
  if(query){clauses.push("(r.content LIKE ? OR u.display_name LIKE ? OR p.name LIKE ? OR o.order_no LIKE ?)"); const value=`%${query}%`; args.push(value,value,value,value);}
  if(/^[1-5]$/.test(rating)){clauses.push("r.rating=?");args.push(Number(rating));}
  const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
  const sql = `SELECT r.id,r.order_id orderId,r.order_item_id orderItemId,r.product_id productId,r.buyer_user_id buyerUserId,u.display_name buyerName,r.rating,r.content,r.status,r.merchant_reply merchantReply,r.merchant_replied_at merchantRepliedAt,r.created_at createdAt,r.hidden_at hiddenAt,p.name productName,o.order_no orderNo,oi.product_name orderItemName FROM product_reviews r JOIN users u ON u.id=r.buyer_user_id JOIN products p ON p.id=r.product_id JOIN orders o ON o.id=r.order_id JOIN order_items oi ON oi.id=r.order_item_id ${where} ORDER BY r.created_at DESC LIMIT 200`;
  return (db.prepare(sql).all(...args) as Record<string,unknown>[]).map(row=>({...mapReview(row),productName:String(row.productName),orderNo:String(row.orderNo),orderItemName:String(row.orderItemName)}));
}
