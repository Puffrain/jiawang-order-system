import { createHash } from "node:crypto";

type BulkPayload = {
  buyerUserIds: string[];
  type: "text" | "product";
  content?: string;
  productId?: string;
};

export function bulkPayloadHash(payload: BulkPayload) {
  const buyerUserIds = [...new Set(payload.buyerUserIds)].sort();
  return createHash("sha256")
    .update(JSON.stringify({ buyerUserIds, type: payload.type, content: payload.type === "text" ? payload.content : undefined, productId: payload.type === "product" ? payload.productId : undefined }))
    .digest("hex");
}
