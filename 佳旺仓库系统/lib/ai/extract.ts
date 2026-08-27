import { BackLabelFields, VisionResult } from "../contracts/pipeline";

const ALIASES: Record<string, keyof BackLabelFields> = {
  productName: "productName", name: "productName", product_name: "productName", 商品名称: "productName", 品名: "productName",
  brand: "brand", 品牌: "brand",
  sku: "sku", productCode: "sku", product_code: "sku", 货号: "sku", 商品编码: "sku",
  barcode: "barcode", barCode: "barcode", 条码: "barcode", 条形码: "barcode",
  netContent: "netContent", net_content: "netContent", content: "netContent", 净含量: "netContent", 规格: "netContent", 容量: "netContent",
  unit: "unit", 单位: "unit", packaging: "packaging", 包装: "packaging", color: "color", 颜色: "color", scent: "scent", 香型: "scent",
  ingredients: "ingredients", 成分: "ingredients", 配料: "ingredients",
  allergens: "allergens", 过敏原: "allergens",
  efficacy: "efficacy", 功效: "efficacy", directions: "directions", 使用方法: "directions", 用法: "directions",
  warnings: "warnings", warning: "warnings", 警示: "warnings", 注意事项: "warnings",
  manufacturer: "manufacturer", 生产商: "manufacturer", 生产企业: "manufacturer",
  countryOfOrigin: "countryOfOrigin", country: "countryOfOrigin", 原产国: "countryOfOrigin", 产地: "countryOfOrigin",
  licenseNumber: "licenseNumber", license: "licenseNumber", 许可证: "licenseNumber", 批准文号: "licenseNumber",
  batchNumber: "batchNumber", batch: "batchNumber", 批次: "batchNumber",
  productionDate: "productionDate", manufacturedAt: "productionDate", 生产日期: "productionDate",
  shelfLife: "shelfLife", shelf_life: "shelfLife", 保质期: "shelfLife",
  price: "price", 价格: "price", stock: "stock", 库存: "stock",
  expiry: "expiry", expiration: "expiry", expiryDate: "expiry", 有效期: "expiry", 到期日: "expiry",
};

export function parseVisionPayload(payload: unknown): VisionResult {
  const parsed = typeof payload === "string" ? parseJsonish(payload) : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AI response must be a JSON object");
  const source = parsed as Record<string, unknown>;
  const allowed = new Set([
    "category", "categoryName", "类别", "分类", "group", "groupName", "分组",
    "backLabel", "back_label", "backLabelFields", "背标", "背标字段",
    "confidence", "score", "置信度", "view", "viewType", "视角",
    "rawText", "ocrText", "识别文本", "barcodeCandidates", "条码候选", "conflicts", "冲突"
  ]);
  const unknown = Object.keys(source).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`AI response contains unknown field: ${unknown}`);
  const category = cleanString(source.category ?? source.categoryName ?? source.类别 ?? source.分类);
  const group = cleanString(source.group ?? source.groupName ?? source.分组);
  const backRaw = source.backLabel ?? source.back_label ?? source.backLabelFields ?? source.背标 ?? source.背标字段;
  const backLabel = normalizeBackLabel(backRaw, { strict: true });
  const confidenceValue = Number(source.confidence ?? source.score ?? source.置信度);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue > 1 ? confidenceValue / 100 : confidenceValue)) : undefined;
  return {
    ...(category ? { category } : {}),
    ...(group ? { group } : {}),
    ...(backLabel ? { backLabel } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    raw: sanitizeRaw(source),
  };
}

export function normalizeBackLabel(value: unknown, options: { preserveEmpty?: boolean; strict?: boolean } = {}): BackLabelFields | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: BackLabelFields = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = ALIASES[key] || (Object.prototype.hasOwnProperty.call(ALIASES, key.trim()) ? ALIASES[key.trim()] : undefined);
    if (!normalizedKey) {
      if (options.strict) throw new Error(`AI response contains unknown back-label field: ${key}`);
      continue;
    }
    const text = cleanString(raw);
    if (text) result[normalizedKey] = text.slice(0, 4_000);
    else if (options.preserveEmpty && (typeof raw === "string" || typeof raw === "number")) result[normalizedKey] = "";
  }
  return Object.keys(result).length ? result : undefined;
}

function parseJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("AI response is empty");
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(withoutFence); } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(withoutFence.slice(start, end + 1)); } catch { /* fall through */ }
    }
  }
  throw new Error("AI response does not contain valid JSON");
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text || undefined;
}

function sanitizeRaw(source: Record<string, unknown>): Record<string, unknown> {
  // Keep only JSON-safe scalar/object data and cap size to prevent a provider
  // from turning the durable job state into an unbounded log.
  try {
    const encoded = JSON.stringify(source);
    if (encoded.length <= 100_000) return JSON.parse(encoded);
    return { truncated: true };
  } catch {
    return { truncated: true };
  }
}
