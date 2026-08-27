import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const migrationsDir = path.resolve('migrations');

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function applyMigrationTransaction(db, sql, version = '021_order_sync_and_inventory_safety.sql') {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version, '2026-08-20T00:00:00.000Z');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('migration 021 safely upgrades historical publication and malformed outbox data', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-migration-021-'));
  const databasePath = path.join(workDir, 'app.db');
  const db = new Database(databasePath);
  try {
    db.exec('PRAGMA foreign_keys=ON;');
    const migrations = fs.readdirSync(migrationsDir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
    for (const migration of migrations.filter((name) => name < '021_')) {
      db.exec(fs.readFileSync(path.join(migrationsDir, migration), 'utf8'));
    }

    const now = '2026-08-20T00:00:00.000Z';
    db.prepare('INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('migration-user', 'migration-user', 'not-a-real-password', 'admin', 1, now, now);

    const insertProduct = db.prepare(`INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at)
      VALUES(?,?,?,'needs_changes',2,NULL,?,?)`);
    for (const id of ['approved-history', 'published-outbox', 'draft-outbox', 'malformed-outbox']) {
      insertProduct.run(id, id, 'cat-pending', now, now);
    }
    db.prepare('INSERT INTO review_decisions(id,product_id,revision,actor_user_id,decision,created_at) VALUES(?,?,?,?,?,?)')
      .run('migration-review', 'approved-history', 2, 'migration-user', 'approve', now);

    const insertOutbox = db.prepare(`INSERT INTO order_sync_outbox
      (id,product_id,revision,event_type,payload_hash,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending',0,?,?,?)`);
    insertOutbox.run('outbox-published', 'published-outbox', 1, 'legacy', null, JSON.stringify({ status: 'published', variants: [{ id: 'sku-1' }] }), now, now, now);
    insertOutbox.run('outbox-draft', 'draft-outbox', 1, 'legacy', null, JSON.stringify({ status: 'draft' }), now, now, now);
    insertOutbox.run('outbox-malformed', 'malformed-outbox', 1, 'legacy', null, '{not-json', now, now, now);

    const migration021 = fs.readFileSync(path.join(migrationsDir, '021_order_sync_and_inventory_safety.sql'), 'utf8');
    assert.throws(() => applyMigrationTransaction(db, `${migration021}\nSELECT * FROM table_that_must_not_exist;`, '021-failure-fixture'), /table_that_must_not_exist/);
    assert.ok(columns(db, 'order_sync_outbox').has('payload_json'), 'rollback keeps the 020 outbox table');
    assert.equal(columns(db, 'order_sync_outbox').has('claim_token'), false, 'rollback removes partial 021 columns');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM order_sync_outbox').get().count, 3, 'rollback preserves legacy outbox rows');
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM schema_migrations WHERE version='021-failure-fixture'`).get().count, 0);

    applyMigrationTransaction(db, migration021);
    applyMigrationTransaction(db, migration021);

    for (const column of ['ever_published_at', 'archived_at']) assert.ok(columns(db, 'products').has(column));
    assert.ok(columns(db, 'product_variants').has('deleted_at'));
    for (const column of ['media_revision', 'claim_token', 'lease_expires_at']) assert.ok(columns(db, 'order_sync_outbox').has(column));
    const outboxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_sync_outbox'").get().sql;
    assert.match(outboxSql, /'superseded'/);

    const publishedAt = db.prepare('SELECT ever_published_at value FROM products WHERE id=?');
    assert.equal(publishedAt.get('approved-history').value, now);
    assert.equal(publishedAt.get('published-outbox').value, now);
    assert.equal(publishedAt.get('draft-outbox').value, null);
    assert.equal(publishedAt.get('malformed-outbox').value, null);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM schema_migrations WHERE version='021_order_sync_and_inventory_safety.sql'`).get().count, 1);
  } finally {
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
