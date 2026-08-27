import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('inventory rejects conflicting replays and releases soft-deleted variants', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSecret = process.env.INTEGRATION_SHARED_SECRET;
  const databasePath = path.join(os.tmpdir(), `warehouse-inventory-${randomUUID()}.db`);
  process.env.DATABASE_PATH = databasePath;
  process.env.INTEGRATION_SHARED_SECRET = 'inventory-runtime-secret-at-least-32-characters';
  const { getDb, closeDb } = await import('../../lib/db');
  const { integrationHeaders } = await import('../../lib/integration-auth');
  const { POST: reserve } = await import('../../app/api/internal/inventory/reserve/route');
  const { POST: release } = await import('../../app/api/internal/inventory/release/route');
  const db = getDb();
  const now = new Date().toISOString();
  const categoryId = 'runtime-category';
  const productId = 'runtime-product';
  const variantId = 'runtime-variant';
  const secondVariantId = 'runtime-variant-second';
  const raceVariantId = 'runtime-variant-race';
  const draftProductId = 'runtime-product-draft';
  const draftVariantId = 'runtime-variant-draft';
  db.prepare('INSERT INTO taxonomy_categories(id,code,name,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(categoryId, categoryId, 'Runtime', 1, 0, now, now);
  db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'published',1,?,?,?)").run(productId, 'Runtime Product', categoryId, now, now, now);
  db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'draft',1,NULL,?,?)").run(draftProductId, 'Draft Product', categoryId, now, now);
  db.prepare('INSERT INTO product_variants(id,product_id,sku,specification,price,stock,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(variantId, productId, 'RUNTIME-1', '500ml', 10, 10, now, now);
  const insertVariant = db.prepare('INSERT INTO product_variants(id,product_id,sku,specification,price,stock,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  insertVariant.run(secondVariantId, productId, 'RUNTIME-2', '250ml', 8, 2, now, now);
  insertVariant.run(raceVariantId, productId, 'RUNTIME-RACE', 'race', 1, 1, now, now);
  insertVariant.run(draftVariantId, draftProductId, 'RUNTIME-DRAFT', 'draft', 1, 5, now, now);

  async function call(pathname: string, body: Record<string, unknown>, handler: (request: Request) => Promise<Response>) {
    const raw = JSON.stringify(body);
    return handler(new Request('http://warehouse.test' + pathname, { method: 'POST', headers: integrationHeaders('POST', pathname, raw, randomUUID()), body: raw }));
  }

  try {
    const reserveBody = { operationId: 'reserve-1', orderId: 'order-1', lines: [{ variantId, quantity: 3 }] };
    const firstReserve = await call('/api/internal/inventory/reserve', reserveBody, reserve);
    assert.equal(firstReserve.status, 200);
    assert.equal((await firstReserve.json() as { data: { replayed: boolean } }).data.replayed, false);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId) as { stock: number }).stock, 7);
    const replayReserve = await call('/api/internal/inventory/reserve', reserveBody, reserve);
    assert.equal(replayReserve.status, 200);
    assert.equal((await replayReserve.json() as { data: { replayed: boolean } }).data.replayed, true);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM inventory_operations WHERE order_id='order-1' AND kind='reserve'").get() as { count: number }).count, 1);
    const conflict = await call('/api/internal/inventory/reserve', { ...reserveBody, operationId: 'reserve-conflict' }, reserve);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');
    const lineConflict = await call('/api/internal/inventory/reserve', { ...reserveBody, lines: [{ variantId, quantity: 2 }] }, reserve);
    assert.equal(lineConflict.status, 409);
    assert.equal((await lineConflict.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');

    const duplicate = await call('/api/internal/inventory/reserve', { operationId: 'reserve-duplicate', orderId: 'order-duplicate', lines: [{ variantId, quantity: 1 }, { variantId, quantity: 1 }] }, reserve);
    assert.equal(duplicate.status, 409);
    const invalidQuantity = await call('/api/internal/inventory/reserve', { operationId: 'reserve-invalid', orderId: 'order-invalid', lines: [{ variantId, quantity: 0 }] }, reserve);
    assert.equal(invalidQuantity.status, 409);
    const draft = await call('/api/internal/inventory/reserve', { operationId: 'reserve-draft', orderId: 'order-draft', lines: [{ variantId: draftVariantId, quantity: 1 }] }, reserve);
    assert.equal(draft.status, 409);

    const beforeRollback = (db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId) as { stock: number }).stock;
    const rollback = await call('/api/internal/inventory/reserve', { operationId: 'reserve-rollback', orderId: 'order-rollback', lines: [{ variantId, quantity: 1 }, { variantId: secondVariantId, quantity: 99 }] }, reserve);
    assert.equal(rollback.status, 409);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId) as { stock: number }).stock, beforeRollback);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(secondVariantId) as { stock: number }).stock, 2);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM inventory_operations WHERE order_id='order-rollback'").get() as { count: number }).count, 0);

    const raceResults = await Promise.all([
      call('/api/internal/inventory/reserve', { operationId: 'reserve-race-a', orderId: 'order-race-a', lines: [{ variantId: raceVariantId, quantity: 1 }] }, reserve),
      call('/api/internal/inventory/reserve', { operationId: 'reserve-race-b', orderId: 'order-race-b', lines: [{ variantId: raceVariantId, quantity: 1 }] }, reserve),
    ]);
    assert.deepEqual(raceResults.map((response) => response.status).sort(), [200, 409]);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(raceVariantId) as { stock: number }).stock, 0);

    db.prepare('UPDATE product_variants SET deleted_at=? WHERE id=?').run(now, variantId);
    const blocked = await call('/api/internal/inventory/reserve', { operationId: 'reserve-2', orderId: 'order-2', lines: [{ variantId, quantity: 1 }] }, reserve);
    assert.equal(blocked.status, 409);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId) as { stock: number }).stock, 7);
    const missingRelease = await call('/api/internal/inventory/release', { operationId: 'release-missing', orderId: 'order-missing' }, release);
    assert.equal(missingRelease.status, 404);
    const releaseBody = { operationId: 'release-1', orderId: 'order-1' };
    const firstRelease = await call('/api/internal/inventory/release', releaseBody, release);
    assert.equal(firstRelease.status, 200);
    assert.equal((await firstRelease.json() as { data: { replayed: boolean } }).data.replayed, false);
    assert.equal((db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId) as { stock: number }).stock, 10);
    const replayRelease = await call('/api/internal/inventory/release', releaseBody, release);
    assert.equal(replayRelease.status, 200);
    assert.equal((await replayRelease.json() as { data: { replayed: boolean } }).data.replayed, true);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM inventory_operations WHERE order_id='order-1' AND kind='release'").get() as { count: number }).count, 1);
    const releaseConflict = await call('/api/internal/inventory/release', { ...releaseBody, operationId: 'release-conflict' }, release);
    assert.equal(releaseConflict.status, 409);
    assert.equal((await releaseConflict.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    closeDb();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousSecret === undefined) delete process.env.INTEGRATION_SHARED_SECRET; else process.env.INTEGRATION_SHARED_SECRET = previousSecret;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
  }
});
