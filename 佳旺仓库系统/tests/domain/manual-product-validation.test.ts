import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBeautyProductInput, ValidationError } from '../../lib/validation';

const assetId = '11111111-1111-4111-8111-111111111111';

test('manual product payload preserves complete purchasable fields', () => {
  const parsed = parseBeautyProductInput({
    name: '专业修护洗发水', categoryId: 'cat-hair-care', assetIds: [assetId],
    description: '适合受损发质', ingredients: '水、表面活性剂', efficacy: '清洁修护', directions: '湿发后使用', warnings: '避免入眼',
    countryOfOrigin: '中国', manufacturer: '示例生产商', licenseNumber: 'XK-001', batchNumber: 'B20260816', productionDate: '2026-08-16', shelfLife: '3 年', expiryDate: '2029-08-15', notes: '内部备注',
    variants: [{ specification: '1000ml / 瓶', sku: 'JW-1000', barcodeRaw: '6901234567892', netContent: '1000ml', unit: '瓶', packaging: '瓶装', color: '白色', scent: '清香', price: 68.5, stock: 120 }],
  });
  assert.deepEqual(parsed.assetIds, [assetId]);
  assert.equal(parsed.variants[0].price, 68.5);
  assert.equal(parsed.variants[0].stock, 120);
  assert.equal(parsed.manufacturer, '示例生产商');
});

test('manual product payload rejects unsafe prices, stock, duplicate SKUs and assets', () => {
  const base = { name: '商品', categoryId: 'cat-hair-care', variants: [{ specification: '标准装', sku: 'SKU-1', price: 1, stock: 1 }] };
  assert.throws(() => parseBeautyProductInput({ ...base, variants: [{ ...base.variants[0], price: -1 }] }), ValidationError);
  assert.throws(() => parseBeautyProductInput({ ...base, variants: [{ ...base.variants[0], stock: 1.5 }] }), ValidationError);
  assert.throws(() => parseBeautyProductInput({ ...base, variants: [base.variants[0], { ...base.variants[0], specification: '另一规格', sku: 'sku-1' }] }), ValidationError);
  assert.throws(() => parseBeautyProductInput({ ...base, variants: [
    { ...base.variants[0], barcodeRaw: '6901234567892' },
    { ...base.variants[0], specification: '另一规格', sku: 'SKU-2', barcodeRaw: '6901234567892' },
  ] }), ValidationError);
  assert.throws(() => parseBeautyProductInput({ ...base, assetIds: [assetId, assetId] }), ValidationError);
  assert.throws(() => parseBeautyProductInput({ ...base, assetIds: Array.from({ length: 9 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`) }), ValidationError);
});
