import test from 'node:test';
import assert from 'node:assert/strict';
import { generateColorVariants, parseUniqueColors, type ColorVariantBase } from '../../lib/bulk-color-variants';

interface TestVariant extends ColorVariantBase {
  price: string;
  stock: string;
  netContent: string;
  packaging: string;
}

const template = (patch: Partial<TestVariant> = {}): TestVariant => ({
  localId: 'template', specification: '', sku: 'SOURCE-SKU', barcodeRaw: 'SOURCE-BARCODE', color: '',
  price: '68', stock: '12', netContent: '100ml', packaging: '盒装', ...patch,
});

test('color input accepts common separators and removes case-insensitive duplicates', () => {
  assert.deepEqual(parseUniqueColors('Black, black\n栗棕色、冷棕色；栗棕色'), ['black', '栗棕色', '冷棕色']);
});

test('a blank template is replaced while common fields are copied and identifiers are cleared', () => {
  let id = 0;
  const source = template();
  const result = generateColorVariants({ existing: [source], template: source, colorText: '黑色\n栗棕色', createId: () => `generated-${++id}` });
  assert.equal(result.variants.length, 2);
  assert.deepEqual(result.variants.map((variant) => variant.color), ['黑色', '栗棕色']);
  assert.ok(result.variants.every((variant) => variant.price === '68' && variant.stock === '12' && variant.netContent === '100ml'));
  assert.ok(result.variants.every((variant) => variant.sku === '' && variant.barcodeRaw === ''));
});

test('existing variants remain intact, duplicate colors are skipped and the total is capped', () => {
  const existing = [template({ localId: 'existing', specification: '黑色', color: '黑色', sku: 'KEEP', barcodeRaw: 'KEEP-BARCODE' })];
  const result = generateColorVariants({ existing, template: existing[0], colorText: '黑色\n栗棕色\n冷棕色', createId: () => 'generated', limit: 2 });
  assert.equal(result.variants[0], existing[0]);
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants[1].color, '栗棕色');
  assert.equal(result.variants[0].sku, 'KEEP');
});
