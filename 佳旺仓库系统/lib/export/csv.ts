import type { ProductRecord } from '../contracts/catalog';

const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

/** Prevent spreadsheet formula injection while preserving the displayed value. */
export function spreadsheetSafe(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  const safe = spreadsheetSafe(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

export const PRODUCT_EXPORT_HEADERS = [
  '商品ID',
  '商品名称',
  '品牌',
  '分类ID',
  '状态',
  '规格',
  'SKU',
  '条码',
  '条码制式',
  '容量',
  '单位',
  '包装',
  '成分',
  '功效',
  '使用方法',
  '警示',
  '产地',
  '生产商',
  '许可证',
  '批次',
  '生产日期',
  '保质期',
  '到期日',
  '备注',
  '审核人',
  '发布时间',
] as const;

export function productsToCsv(products: ProductRecord[]): string {
  const rows: string[][] = [Array.from(PRODUCT_EXPORT_HEADERS)];
  for (const product of products.filter((item) => item.status === 'published')) {
    for (const variant of product.variants) {
      rows.push([
        product.id,
        product.name,
        product.brand ?? '',
        product.categoryId,
        product.status,
        variant.specification,
        variant.sku ?? '',
        variant.barcodeNormalized ?? variant.barcodeRaw ?? '',
        variant.barcodeSymbology ?? '',
        variant.netContent ?? '',
        variant.unit ?? '',
        variant.packaging ?? '',
        product.ingredients ?? '',
        product.efficacy ?? '',
        product.directions ?? '',
        product.warnings ?? '',
        product.countryOfOrigin ?? '',
        product.manufacturer ?? '',
        product.licenseNumber ?? '',
        product.batchNumber ?? '',
        product.productionDate ?? '',
        product.shelfLife ?? '',
        product.expiryDate ?? '',
        product.notes ?? '',
        product.reviewedBy ?? '',
        product.publishedAt ?? '',
      ]);
    }
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
