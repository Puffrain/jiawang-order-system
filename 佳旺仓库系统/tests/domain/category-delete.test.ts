import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('category deletion protects system and referenced categories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-category-delete-'));
  process.env.DATABASE_PATH = path.join(root, 'catalog.sqlite');
  Object.assign(process.env, { NODE_ENV: 'test' });
  const { getDb, closeDb } = await import('../../lib/db');
  try {
    try { getDb(); } catch { t.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
    const { deleteCategory, listCategories, saveCategory } = await import('../../lib/catalog-repository');

    assert.throws(() => deleteCategory('cat-pending'), /系统保留类目/);
    assert.throws(() => saveCategory({ id: 'cat-pending', name: '待定', code: 'renamed-pending' }), /系统保留类目/);
    assert.throws(() => deleteCategory('cat-pending'), /系统保留类目/);
    const parent = saveCategory({ name: '测试父类目', code: 'delete-test-parent' });
    const child = saveCategory({ name: '测试子类目', code: 'delete-test-child', parentId: parent.id });
    assert.throws(() => deleteCategory(parent.id), /子类目 1/);

    deleteCategory(child.id);
    deleteCategory(parent.id);
    assert.equal(listCategories(true).some((category) => category.id === parent.id || category.id === child.id), false);
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    await fs.rm(root, { recursive: true, force: true });
  }
});
