import test from 'node:test';
import assert from 'node:assert/strict';
import { validateForPublish, type ProductRecord } from '../../lib/contracts/catalog';
import { normalizeBarcode } from '../../lib/barcode';
import { productsToCsv, spreadsheetSafe } from '../../lib/export/csv';

test('publish validation requires identity and a specification', () => {
  const invalid = validateForPublish({ name: '', categoryId: '', variants: [] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 3);
  const valid = validateForPublish({ name: '护发素', categoryId: 'hair-care', variants: [{ specification: '500ml / 瓶' }] });
  assert.equal(valid.ok, true);
  assert.equal(validateForPublish({ name: '待识别商品-item123', categoryId: 'hair-care', variants: [{ specification: '待补充' }] }).ok, false);
});

test('EAN and UPC are preserved as text and checksum validated', () => {
  assert.deepEqual(normalizeBarcode('6901234567892'), {
    raw: '6901234567892', normalized: '6901234567892', symbology: 'EAN_13', checksumValid: true,
  });
  assert.equal(normalizeBarcode('001234567890').normalized, '001234567890');
});

test('CSV includes only published products and neutralizes formulas', () => {
  assert.equal(spreadsheetSafe('=WEBSERVICE("https://bad")').startsWith("'="), true);
  const base: ProductRecord = {
    id: 'prod-1', name: '=危险名称', categoryId: 'hair-care', entrySource: 'manual', status: 'published', revision: 1,
    variants: [{ specification: '500ml', barcodeRaw: '001234567890' }],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  const csv = productsToCsv([base, { ...base, id: 'draft', status: 'draft' }]);
  assert.match(csv, /prod-1/);
  assert.doesNotMatch(csv, /draft/);
  assert.match(csv, /'=危险名称/);
});
