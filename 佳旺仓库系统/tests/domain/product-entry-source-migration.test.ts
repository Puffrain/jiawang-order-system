import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

test('entry source migration preserves manual products and backfills AI products', (t) => {
  let db: Database.Database;
  try {
    db = new Database(':memory:');
  } catch {
    t.skip('better-sqlite3 native binding is unavailable for this Node runtime');
    return;
  }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, source_group_id TEXT)');
    db.prepare('INSERT INTO products (id, source_group_id) VALUES (?, ?)').run('manual-product', null);
    db.prepare('INSERT INTO products (id, source_group_id) VALUES (?, ?)').run('ai-product', 'group-1');
    db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', '020_product_entry_source.sql'), 'utf8'));

    const rows = db.prepare('SELECT id, entry_source entrySource FROM products ORDER BY id').all() as Array<{ id: string; entrySource: string }>;
    assert.deepEqual(rows, [
      { id: 'ai-product', entrySource: 'ai' },
      { id: 'manual-product', entrySource: 'manual' },
    ]);
  } finally {
    db.close();
  }
});
