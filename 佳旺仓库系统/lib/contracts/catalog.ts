import type { Role } from './platform';

export const PRODUCT_STATUSES = [
  'draft',
  'review_pending',
  'needs_changes',
  'approved',
  'published',
  'rejected',
] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export type ProductEntrySource = 'manual' | 'ai';

export interface ProductVariantInput {
  id?: string;
  sku?: string | null;
  barcodeRaw?: string | null;
  barcodeNormalized?: string | null;
  barcodeSymbology?: 'EAN_13' | 'UPC_A' | 'CODE_128' | 'UNKNOWN' | null;
  barcodeValid?: boolean | null;
  specification: string;
  netContent?: string | null;
  unit?: string | null;
  packaging?: string | null;
  color?: string | null;
  scent?: string | null;
  price?: number | null;
  stock?: number | null;
}

export interface BeautyProductInput {
  name: string;
  brand?: string | null;
  categoryId: string;
  subcategoryId?: string | null;
  description?: string | null;
  ingredients?: string | null;
  efficacy?: string | null;
  directions?: string | null;
  warnings?: string | null;
  countryOfOrigin?: string | null;
  manufacturer?: string | null;
  licenseNumber?: string | null;
  batchNumber?: string | null;
  productionDate?: string | null;
  shelfLife?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  variants: ProductVariantInput[];
  /** Ordered publication-safe derivatives; the first item is the primary image. */
  assetIds?: string[];
  sourceGroupId?: string | null;
}

export interface ProductRecord extends BeautyProductInput {
  id: string;
  entrySource: ProductEntrySource;
  status: ProductStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  publishedAt?: string | null;
  /** Controlled media endpoints; never a filesystem path. */
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  assetIds?: string[];
  /** Approved derivative assets that may be copied to the order storefront. */
  publishedAssetIds?: string[];
  orderSyncStatus?: "pending" | "delivered" | "dead" | null;
  orderSyncAttempts?: number;
  orderSyncError?: string | null;
}

export type EvidenceSource = 'vision' | 'barcode' | 'human' | 'import';
export type EvidenceState = 'suggested' | 'accepted' | 'rejected' | 'not_found' | 'conflict';

export interface FieldEvidence {
  id: string;
  productId?: string | null;
  groupId?: string | null;
  fieldKey: string;
  rawValue?: string | null;
  normalizedValue?: string | null;
  confidence?: number | null;
  source: EvidenceSource;
  state: EvidenceState;
  sourceAssetIds: string[];
  sourceRegion?: { x: number; y: number; width: number; height: number } | null;
  aiRunId?: string | null;
  revision: number;
  createdAt: string;
}

export interface ReviewDecision {
  id: string;
  productId: string;
  revision: number;
  actorUserId: string;
  actorRole: Extract<Role, 'admin' | 'reviewer'>;
  decision: 'approve' | 'reject' | 'needs_changes';
  reason?: string | null;
  createdAt: string;
}

export interface CategoryRecord {
  id: string;
  code: string;
  name: string;
  parentId?: string | null;
  active: boolean;
  sortOrder: number;
}

export interface PublishValidation {
  ok: boolean;
  errors: Array<{ field: string; message: string }>;
}

export function validateForPublish(input: BeautyProductInput): PublishValidation {
  const errors: PublishValidation['errors'] = [];
  if (!input.name.trim() || isSyntheticPlaceholder(input.name)) errors.push({ field: 'name', message: '商品名称必须由人工确认，不能使用待识别占位值' });
  if (!input.categoryId.trim()) errors.push({ field: 'categoryId', message: '请选择有效分类' });
  if (!input.variants.length) errors.push({ field: 'variants', message: '至少需要一个规格' });
  input.variants.forEach((variant, index) => {
    if (!variant.specification.trim() || isSyntheticPlaceholder(variant.specification)) {
      errors.push({ field: `variants.${index}.specification`, message: '规格/包装单位必须由人工确认，不能使用待补充占位值' });
    }
    if (variant.price != null && (!Number.isFinite(variant.price) || variant.price < 0)) {
      errors.push({ field: `variants.${index}.price`, message: '价格必须为非负数' });
    }
    if (variant.stock != null && (!Number.isInteger(variant.stock) || variant.stock < 0)) {
      errors.push({ field: `variants.${index}.stock`, message: '库存必须为非负整数' });
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Values used only as UI/model placeholders must never satisfy a publish
 * invariant.  Keep this deliberately narrow so legitimate product names
 * containing words such as“待定” can still be reviewed and published. */
function isSyntheticPlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/[\s_-]+/g, '');
  return /^待识别商品(?:[A-Za-z0-9]+)?$/u.test(normalized)
    || normalized === '待补充'
    || normalized === '未识别'
    || normalized === '未知';
}
