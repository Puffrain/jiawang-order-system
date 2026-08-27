import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProductRecord } from '../../lib/contracts/catalog';

test('outbox claim fencing allows one effective completion and rejects a stale token', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSecret = process.env.INTEGRATION_SHARED_SECRET;
  const previousOrderUrl = process.env.ORDER_INTERNAL_URL;
  const previousFetch = globalThis.fetch;
  const databasePath = path.join(os.tmpdir(), `warehouse-outbox-${randomUUID()}.db`);
  process.env.DATABASE_PATH = databasePath;
  process.env.INTEGRATION_SHARED_SECRET = 'outbox-runtime-secret-at-least-32-characters';
  process.env.ORDER_INTERNAL_URL = 'http://order.test';

  const { getDb, closeDb } = await import('../../lib/db');
  const { enqueueOrderProduct, processOrderSyncOutbox } = await import('../../lib/order-sync');
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO taxonomy_categories(id,code,name,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('outbox-category', 'outbox-category', 'Outbox', 1, 0, now, now);
  db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'published',1,?,?,?)")
    .run('outbox-product', 'Outbox Product', 'outbox-category', now, now, now);
  db.prepare('INSERT INTO product_variants(id,product_id,sku,specification,price,stock,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('outbox-variant', 'outbox-product', 'OUTBOX-1', '500ml', 10, 5, now, now);

  const product: ProductRecord = {
    id: 'outbox-product',
    name: 'Outbox Product',
    categoryId: 'outbox-category',
    variants: [{ id: 'outbox-variant', sku: 'OUTBOX-1', specification: '500ml', price: 10, stock: 5 }],
    entrySource: 'manual',
    status: 'published',
    revision: 1,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    publishedAssetIds: [],
  };

  try {
    enqueueOrderProduct(product);
    let requests = 0;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await fetchGate;
      return Response.json({
        ok: true,
        eventType: event.eventType,
        warehouseProductId: event.id,
        productId: 'order-product',
        revision: event.revision,
        payloadHash: event.payloadHash,
        saleStatus: event.saleStatus,
        status: event.saleStatus,
        mediaStatus: 'pending',
        disposition: 'applied',
      });
    };

    const first = processOrderSyncOutbox(1);
    await waitFor(() => requests === 1);
    const second = await processOrderSyncOutbox(1);
    assert.equal(second, 0);
    assert.equal(requests, 1, 'an active claim must prevent a second external request');
    releaseFetch();
    assert.equal(await first, 1);
    assert.equal((db.prepare('SELECT status FROM order_sync_outbox WHERE product_id=?').get(product.id) as { status: string }).status, 'delivered');

    db.prepare(`UPDATE order_sync_outbox SET status='pending',delivered_at=NULL,next_attempt_at=?,claim_token=NULL,lease_expires_at=NULL WHERE product_id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), product.id);
    requests = 0;
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await staleGate;
      return Response.json({ ok: true, eventType: event.eventType, warehouseProductId: event.id, productId: 'order-product', revision: event.revision, payloadHash: event.payloadHash, saleStatus: event.saleStatus, status: event.saleStatus, mediaStatus: 'pending', disposition: 'applied' });
    };
    const staleWorker = processOrderSyncOutbox(1);
    await waitFor(() => requests === 1);
    const original = db.prepare('SELECT claim_token token FROM order_sync_outbox WHERE product_id=?').get(product.id) as { token: string };
    const replacementToken = randomUUID();
    db.prepare('UPDATE order_sync_outbox SET claim_token=?,lease_expires_at=? WHERE product_id=? AND claim_token=?')
      .run(replacementToken, new Date(Date.now() + 60_000).toISOString(), product.id, original.token);
    releaseStale();
    assert.equal(await staleWorker, 0, 'a stale token cannot complete the row');
    const fenced = db.prepare('SELECT status,claim_token token FROM order_sync_outbox WHERE product_id=?').get(product.id) as { status: string; token: string };
    assert.deepEqual(fenced, { status: 'pending', token: replacementToken });

    db.prepare('UPDATE order_sync_outbox SET claim_token=NULL,lease_expires_at=NULL,next_attempt_at=?,attempt_count=0 WHERE product_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), product.id);
    let releaseExpiredAck!: () => void;
    const expiredAckGate = new Promise<void>((resolve) => { releaseExpiredAck = resolve; });
    requests = 0;
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await expiredAckGate;
      return Response.json({ ok: true, eventType: event.eventType, warehouseProductId: event.id, productId: 'order-product', revision: event.revision, payloadHash: event.payloadHash, saleStatus: event.saleStatus, status: event.saleStatus, mediaStatus: 'pending', disposition: 'applied' });
    };
    const expiredAckWorker = processOrderSyncOutbox(1);
    await waitFor(() => requests === 1);
    db.prepare('UPDATE order_sync_outbox SET lease_expires_at=? WHERE product_id=?').run(new Date(Date.now() - 1000).toISOString(), product.id);
    releaseExpiredAck();
    assert.equal(await expiredAckWorker, 0, 'an expired lease cannot apply a successful acknowledgement');
    const afterExpiredAck = db.prepare('SELECT status,attempt_count attempts,claim_token token FROM order_sync_outbox WHERE product_id=?').get(product.id) as { status: string; attempts: number; token: string };
    assert.equal(afterExpiredAck.status, 'pending');
    assert.equal(afterExpiredAck.attempts, 0);
    assert.ok(afterExpiredAck.token);

    db.prepare('UPDATE order_sync_outbox SET claim_token=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE product_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), product.id);
    let releaseExpiredFailure!: () => void;
    const expiredFailureGate = new Promise<void>((resolve) => { releaseExpiredFailure = resolve; });
    requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      await expiredFailureGate;
      throw new Error('simulated delivery failure');
    };
    const expiredFailureWorker = processOrderSyncOutbox(1);
    await waitFor(() => requests === 1);
    db.prepare('UPDATE order_sync_outbox SET lease_expires_at=? WHERE product_id=?').run(new Date(Date.now() - 1000).toISOString(), product.id);
    releaseExpiredFailure();
    assert.equal(await expiredFailureWorker, 0);
    const afterExpiredFailure = db.prepare('SELECT status,attempt_count attempts,claim_token token FROM order_sync_outbox WHERE product_id=?').get(product.id) as { status: string; attempts: number; token: string };
    assert.equal(afterExpiredFailure.status, 'pending');
    assert.equal(afterExpiredFailure.attempts, 0, 'an expired lease cannot advance failure attempts');
    assert.ok(afterExpiredFailure.token);

    db.prepare('UPDATE order_sync_outbox SET claim_token=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE product_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), product.id);
    let releaseSupersedeRace!: () => void;
    const supersedeRaceGate = new Promise<void>((resolve) => { releaseSupersedeRace = resolve; });
    requests = 0;
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await supersedeRaceGate;
      return Response.json({ ok: true, eventType: event.eventType, warehouseProductId: event.id, productId: 'order-product', revision: event.revision, payloadHash: event.payloadHash, saleStatus: event.saleStatus, status: event.saleStatus, mediaStatus: 'pending', disposition: 'applied' });
    };
    const supersedeRaceWorker = processOrderSyncOutbox(1);
    await waitFor(() => requests === 1);
    const raceClaim = db.prepare('SELECT claim_token token FROM order_sync_outbox WHERE product_id=? AND revision=1').get(product.id) as { token: string };
    db.prepare(`INSERT INTO order_sync_outbox(id,product_id,revision,event_type,media_revision,payload_hash,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
      SELECT ?,product_id,2,event_type,2,payload_hash,payload_json,'pending',0,?, ?,? FROM order_sync_outbox WHERE product_id=? AND revision=1`)
      .run(randomUUID(), now, now, now, product.id);
    const takeoverToken = randomUUID();
    db.prepare('UPDATE order_sync_outbox SET claim_token=?,lease_expires_at=? WHERE product_id=? AND revision=1 AND claim_token=?')
      .run(takeoverToken, new Date(Date.now() + 60_000).toISOString(), product.id, raceClaim.token);
    releaseSupersedeRace();
    assert.equal(await supersedeRaceWorker, 0);
    const afterSupersedeRace = db.prepare('SELECT status,claim_token token FROM order_sync_outbox WHERE product_id=? AND revision=1').get(product.id) as { status: string; token: string };
    assert.deepEqual(afterSupersedeRace, { status: 'pending', token: takeoverToken }, 'a stale worker cannot supersede a row claimed by its successor');
    db.prepare('DELETE FROM order_sync_outbox WHERE product_id=? AND revision=2').run(product.id);

    db.prepare(`UPDATE order_sync_outbox SET payload_json=?,payload_hash=?,claim_token=?,lease_expires_at=? WHERE product_id=? AND revision=1`)
      .run(JSON.stringify({
        id: product.id,
        revision: 1,
        eventType: 'warehouse.catalog.product.current',
        mediaRevision: 1,
        payloadHash: '0'.repeat(64),
      }), '0'.repeat(64), replacementToken, new Date(Date.now() + 60_000).toISOString(), product.id);
    enqueueOrderProduct(product);
    const repaired = db.prepare('SELECT payload_json payloadJson,payload_hash payloadHash,claim_token token,lease_expires_at lease FROM order_sync_outbox WHERE product_id=? AND revision=1').get(product.id) as { payloadJson: string; payloadHash: string; token: string | null; lease: string | null };
    assert.equal(JSON.parse(repaired.payloadJson).payloadHash, repaired.payloadHash);
    assert.deepEqual({ token: repaired.token, lease: repaired.lease }, { token: null, lease: null });
    const repairAudit = db.prepare(`SELECT metadata_json metadata FROM audit_log WHERE action='order_sync.payload_repaired' AND resource_id=(SELECT id FROM order_sync_outbox WHERE product_id=? AND revision=1) ORDER BY created_at DESC LIMIT 1`).get(product.id) as { metadata: string };
    const repairMetadata = JSON.parse(repairAudit.metadata) as Record<string, unknown>;
    assert.equal(repairMetadata.reason, 'payload_hash_mismatch');
    assert.match(String(repairMetadata.previousPayloadHash), /^[a-f0-9]{64}$/);
    assert.equal(repairMetadata.newPayloadHash, repaired.payloadHash);
    assert.equal(repairAudit.metadata.includes('warehouse.catalog.product.current'), false, 'audit must not retain damaged payload bytes');

    db.prepare(`UPDATE order_sync_outbox SET event_type='damaged.metadata' WHERE product_id=? AND revision=1`).run(product.id);
    enqueueOrderProduct(product);
    assert.equal((db.prepare('SELECT event_type eventType FROM order_sync_outbox WHERE product_id=? AND revision=1').get(product.id) as { eventType: string }).eventType, 'warehouse.catalog.product.current');
    const metadataRepair = db.prepare(`SELECT metadata_json metadata FROM audit_log WHERE action='order_sync.payload_repaired' AND resource_id=(SELECT id FROM order_sync_outbox WHERE product_id=? AND revision=1) ORDER BY rowid DESC LIMIT 1`).get(product.id) as { metadata: string };
    assert.equal(JSON.parse(metadataRepair.metadata).reason, 'outbox_metadata_mismatch');

    db.prepare('UPDATE products SET revision=2 WHERE id=?').run(product.id);
    db.prepare(`UPDATE order_sync_outbox SET payload_hash='broken' WHERE product_id=? AND revision=1`).run(product.id);
    assert.throws(() => enqueueOrderProduct(product), /Only the current product revision/, 'a stale warehouse snapshot cannot repair historical payloads');
    const staleNeverQueued = { ...product, id: 'stale-never-queued' };
    db.prepare("INSERT INTO products(id,name,category_id,status,revision,published_at,created_at,updated_at) VALUES(?,?,?,'published',2,?,?,?)")
      .run(staleNeverQueued.id, staleNeverQueued.name, staleNeverQueued.categoryId, now, now, now);
    assert.throws(() => enqueueOrderProduct(staleNeverQueued), /Only the current product revision/, 'a stale snapshot cannot create a historical row');
    assert.equal((db.prepare('SELECT COUNT(*) count FROM order_sync_outbox WHERE product_id=?').get(staleNeverQueued.id) as { count: number }).count, 0);
    db.prepare('UPDATE products SET revision=1 WHERE id=?').run(product.id);
    db.prepare('UPDATE order_sync_outbox SET payload_hash=? WHERE product_id=? AND revision=1').run(repaired.payloadHash, product.id);

    db.prepare(`UPDATE order_sync_outbox SET status='delivered',payload_json=?,payload_hash=? WHERE product_id=? AND revision=1`)
      .run('{"eventType":"warehouse.catalog.product.current","payloadHash":"broken"}', 'broken', product.id);
    assert.throws(() => enqueueOrderProduct(product), /payload is immutable/, 'delivered payloads remain immutable even when damaged');
    db.prepare(`UPDATE order_sync_outbox SET status='pending',payload_json=?,payload_hash=?,next_attempt_at=? WHERE product_id=? AND revision=1`)
      .run(repaired.payloadJson, repaired.payloadHash, now, product.id);

    db.prepare('UPDATE products SET revision=2,updated_at=? WHERE id=?').run(now, product.id);
    enqueueOrderProduct({ ...product, revision: 2, updatedAt: now });
    const obsolete = db.prepare('SELECT status,claim_token token,lease_expires_at lease FROM order_sync_outbox WHERE product_id=? AND revision=1').get(product.id) as { status: string; token: string | null; lease: string | null };
    assert.deepEqual(obsolete, { status: 'superseded', token: null, lease: null });
  } finally {
    globalThis.fetch = previousFetch;
    closeDb();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousSecret === undefined) delete process.env.INTEGRATION_SHARED_SECRET; else process.env.INTEGRATION_SHARED_SECRET = previousSecret;
    if (previousOrderUrl === undefined) delete process.env.ORDER_INTERNAL_URL; else process.env.ORDER_INTERNAL_URL = previousOrderUrl;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for concurrent worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
