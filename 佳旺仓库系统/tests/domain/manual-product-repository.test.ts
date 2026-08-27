import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('manual product keeps variant identities and ordered prepared media', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-manual-product-'));
  process.env.DATABASE_PATH = path.join(root, 'catalog.sqlite');
  Object.assign(process.env, { NODE_ENV: 'test' });
  const { getDb, closeDb } = await import('../../lib/db');
  try {
    let db;
    try { db = getDb(); } catch { t.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
    const { createProduct, getProduct, reviewProduct, saveCategory, updateProduct } = await import('../../lib/catalog-repository');
    const parent = saveCategory({ name: '人工测试一级类目', code: 'manual-parent' });
    const child = saveCategory({ name: '人工测试二级类目', code: 'manual-child', parentId: parent.id });
    const other = saveCategory({ name: '其他一级类目', code: 'manual-other' });
    const assetId = '11111111-1111-4111-8111-111111111111';
    db.prepare(`INSERT INTO pipeline_assets (id,sha256,path,filename,mime_type,bytes,width,height,pixels,has_exif,source_asset_id,derivative_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(assetId, 'a'.repeat(64), path.join(root, 'image.webp'), 'image.webp', 'image/webp', 10, 10, 10, 100, 0, null, 'normalized', new Date().toISOString());

    const created = createProduct({
      name: '人工商品', brand: '测试品牌', categoryId: parent.id, subcategoryId: child.id, assetIds: [assetId],
      description: '商品卖点', ingredients: '成分信息', efficacy: '主要功效', directions: '使用方法', warnings: '注意事项',
      countryOfOrigin: '中国', manufacturer: '测试生产商', licenseNumber: 'XK-001', batchNumber: 'B20260816',
      productionDate: '2026-08-16', shelfLife: '3 年', expiryDate: '2029-08-15', notes: '内部备注',
      variants: [
        { specification: '500ml', sku: 'MANUAL-500', barcodeRaw: '6901234567892', netContent: '500ml', unit: '瓶', packaging: '瓶装', color: '白色', scent: '清香', price: 38, stock: 10 },
        { specification: '1000ml', sku: 'MANUAL-1000', netContent: '1000ml', unit: '瓶', packaging: '瓶装', price: 68, stock: 20 },
      ],
    });
    assert.equal(created.entrySource, 'manual');
    assert.deepEqual(created.assetIds, [assetId]);
    assert.equal(created.brand, '测试品牌');
    assert.equal(created.description, '商品卖点');
    assert.equal(created.ingredients, '成分信息');
    assert.equal(created.efficacy, '主要功效');
    assert.equal(created.directions, '使用方法');
    assert.equal(created.warnings, '注意事项');
    assert.equal(created.countryOfOrigin, '中国');
    assert.equal(created.manufacturer, '测试生产商');
    assert.equal(created.licenseNumber, 'XK-001');
    assert.equal(created.batchNumber, 'B20260816');
    assert.equal(created.productionDate, '2026-08-16');
    assert.equal(created.shelfLife, '3 年');
    assert.equal(created.expiryDate, '2029-08-15');
    assert.equal(created.notes, '内部备注');
    assert.equal(created.variants[0].barcodeNormalized, '6901234567892');
    assert.equal(created.variants[0].netContent, '500ml');
    assert.equal(created.variants[0].unit, '瓶');
    assert.equal(created.variants[0].packaging, '瓶装');
    assert.equal(created.variants[0].color, '白色');
    assert.equal(created.variants[0].scent, '清香');
    const ids = created.variants.map((variant) => variant.id);

    const updated = updateProduct(created.id, {
      ...created,
      variants: [
        { ...created.variants[0], price: 36, stock: 8 },
        { ...created.variants[1], price: 66, stock: 18 },
      ],
    }, created.revision);
    assert.deepEqual(updated.variants.map((variant) => variant.id), ids);
    assert.deepEqual(getProduct(created.id)?.assetIds, [assetId]);
    assert.throws(() => updateProduct(created.id, { ...updated, categoryId: other.id, subcategoryId: child.id }, updated.revision), /子类目/);

    const incomplete = createProduct({
      name: '未完成的人工商品', categoryId: parent.id,
      variants: [{ specification: '标准装' }],
    });
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES ('manual-reviewer','manual-reviewer','test','reviewer',1,datetime('now'),datetime('now'))").run();
    assert.throws(
      () => reviewProduct(incomplete.id, { id: 'manual-reviewer', role: 'reviewer' }, 'approve'),
      /至少需要一张已处理图片.*必须填写价格.*必须填写库存/
    );
    const published = reviewProduct(updated.id, { id: 'manual-reviewer', role: 'reviewer' }, 'approve', undefined, updated.revision);
    assert.equal(published.status, 'published');
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    await fs.rm(root, { recursive: true, force: true });
  }
});
