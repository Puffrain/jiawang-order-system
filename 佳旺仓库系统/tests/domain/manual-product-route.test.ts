import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('manual product routes enforce reviewer access, request guards and publication readiness', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-manual-route-'));
  const previous = {
    database: process.env.DATABASE_PATH,
    origin: process.env.APP_ORIGIN,
    requireOrigin: process.env.REQUIRE_ORIGIN,
    requireCsrf: process.env.REQUIRE_CSRF,
    nodeEnv: process.env.NODE_ENV,
    mediaRoot: process.env.PIPELINE_MEDIA_ROOT,
  };
  const mediaRoot = path.join(root, 'media');
  Object.assign(process.env, {
    DATABASE_PATH: path.join(root, 'catalog.sqlite'),
    APP_ORIGIN: 'https://warehouse.test',
    REQUIRE_ORIGIN: 'true',
    REQUIRE_CSRF: 'true',
    NODE_ENV: 'test',
    PIPELINE_MEDIA_ROOT: mediaRoot,
  });
  const { getDb, closeDb } = await import('../../lib/db');
  try {
    let db;
    try { db = getDb(); } catch { t.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
    const timestamp = new Date().toISOString();
    const insertUser = db.prepare('INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
    insertUser.run('manual-route-reviewer', 'manual-route-reviewer', 'test', 'reviewer', timestamp, timestamp);
    insertUser.run('manual-route-viewer', 'manual-route-viewer', 'test', 'viewer', timestamp, timestamp);

    const { getProduct, saveCategory } = await import('../../lib/catalog-repository');
    const category = saveCategory({ name: '人工接口测试类目', code: 'manual-route-category' });
    const { createSession } = await import('../../lib/session');
    const reviewer = createSession('manual-route-reviewer');
    const viewer = createSession('manual-route-viewer');
    const { POST: createRoute } = await import('../../app/api/v1/catalog/products/route');
    const { POST: reviewRoute } = await import('../../app/api/v1/review/items/[id]/decision/route');
    const { POST: prepareAssetRoute } = await import('../../app/api/v1/catalog/assets/prepare/route');
    const { POST: createUploadRoute } = await import('../../app/api/v1/uploads/route');
    const { PUT: uploadChunkRoute } = await import('../../app/api/v1/uploads/[uploadId]/chunks/[chunkIndex]/route');
    const { POST: completeUploadRoute } = await import('../../app/api/v1/uploads/[uploadId]/complete/route');
    const { getPipelineRuntime, resetPipelineRuntimeForTests } = await import('../../lib/jobs/runtime');

    const nonImageAssetId = '11111111-1111-4111-8111-111111111111';
    getPipelineRuntime().store.putAsset({
      id: nonImageAssetId,
      sha256: 'a'.repeat(64),
      path: path.join(root, 'not-an-image.txt'),
      filename: 'not-an-image.txt',
      mimeType: 'text/plain',
      bytes: 10,
      createdAt: timestamp,
    });

    const productBody = JSON.stringify({
      name: '接口测试人工商品',
      categoryId: category.id,
      variants: [{ specification: '标准装' }],
    });
    const request = (token: string, options: { origin?: boolean; csrf?: boolean } = {}, body = productBody) => {
      const csrf = 'manual-route-csrf';
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        cookie: `jw_session=${token}${options.csrf === false ? '' : `; jw_csrf=${csrf}`}`,
      };
      if (options.origin !== false) headers.origin = 'https://warehouse.test';
      if (options.csrf !== false) headers['x-csrf-token'] = csrf;
      return new Request('https://warehouse.test/api/v1/catalog/products', { method: 'POST', headers, body });
    };

    assert.equal((await createRoute(request(viewer.token))).status, 403);
    assert.equal((await createRoute(request(reviewer.token, { origin: false }))).status, 403);
    assert.equal((await createRoute(request(reviewer.token, { csrf: false }))).status, 403);

    const prepareRequest = (token: string, assetId = nonImageAssetId) => new Request('https://warehouse.test/api/v1/catalog/assets/prepare', {
      method: 'POST',
      headers: {
        origin: 'https://warehouse.test',
        'content-type': 'application/json',
        cookie: `jw_session=${token}; jw_csrf=manual-route-csrf`,
        'x-csrf-token': 'manual-route-csrf',
      },
      body: JSON.stringify({ assetId }),
    });
    assert.equal((await prepareAssetRoute(prepareRequest(viewer.token))).status, 403);
    const nonImageResponse = await prepareAssetRoute(prepareRequest(reviewer.token));
    assert.equal(nonImageResponse.status, 400);
    const nonImagePayload = await nonImageResponse.json() as { error?: { code?: string } };
    assert.equal(nonImagePayload.error?.code, 'ASSET_TYPE');

    const { default: sharp } = await import('sharp');
    const imageBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 220, g: 40, b: 50 } } }).png().toBuffer();
    const imageDigest = createHash('sha256').update(imageBytes).digest('hex');
    const mutationHeaders = {
      origin: 'https://warehouse.test',
      cookie: `jw_session=${reviewer.token}; jw_csrf=manual-route-csrf`,
      'x-csrf-token': 'manual-route-csrf',
    };
    const uploadResponse = await createUploadRoute(new Request('https://warehouse.test/api/v1/uploads', {
      method: 'POST',
      headers: { ...mutationHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'manual-product.png', expectedBytes: imageBytes.length, expectedChunks: 1, chunkSize: imageBytes.length, mimeType: 'image/png' }),
    }));
    assert.equal(uploadResponse.status, 201);
    const uploadPayload = await uploadResponse.json() as { data?: { upload?: { id?: string } } };
    const uploadId = uploadPayload.data?.upload?.id;
    assert.ok(uploadId);
    const chunkResponse = await uploadChunkRoute(new Request(`https://warehouse.test/api/v1/uploads/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { ...mutationHeaders, 'content-length': String(imageBytes.length), 'x-chunk-sha256': imageDigest },
      body: new Uint8Array(imageBytes),
    }), { params: Promise.resolve({ uploadId, chunkIndex: '0' }) });
    assert.equal(chunkResponse.status, 200);
    const completedResponse = await completeUploadRoute(new Request(`https://warehouse.test/api/v1/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: { ...mutationHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: imageDigest }),
    }), { params: Promise.resolve({ uploadId }) });
    assert.equal(completedResponse.status, 201);
    const completedPayload = await completedResponse.json() as { data?: { asset?: { id?: string; path?: string } } };
    const imageAssetId = completedPayload.data?.asset?.id;
    assert.ok(imageAssetId);
    assert.equal(completedPayload.data?.asset?.path, undefined);

    const preparedImageResponse = await prepareAssetRoute(prepareRequest(reviewer.token, imageAssetId));
    assert.equal(preparedImageResponse.status, 201);
    const preparedImagePayload = await preparedImageResponse.json() as { data?: { asset?: { id?: string; path?: string; mimeType?: string; hasExif?: boolean; sourceAssetId?: string; derivativeKind?: string } } };
    const preparedImage = preparedImagePayload.data?.asset;
    assert.ok(preparedImage?.id);
    assert.equal(preparedImage.mimeType, 'image/webp');
    assert.equal(preparedImage.hasExif, false);
    assert.equal(preparedImage.sourceAssetId, imageAssetId);
    assert.equal(preparedImage.derivativeKind, 'normalized');
    assert.equal(preparedImage.path, undefined);
    const persistedImage = getPipelineRuntime().store.getAsset(preparedImage.id);
    assert.ok(persistedImage?.path);
    assert.equal((await fs.stat(persistedImage.path)).isFile(), true);

    const createdResponse = await createRoute(request(reviewer.token));
    assert.equal(createdResponse.status, 201);
    const createdPayload = await createdResponse.json() as { data?: { product?: { id?: string; revision?: number; entrySource?: string } } };
    const product = createdPayload.data?.product;
    assert.ok(product?.id);
    assert.equal(product.entrySource, 'manual');

    const csrf = 'manual-route-csrf';
    const reviewResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${product.id}/decision`, {
      method: 'POST',
      headers: {
        origin: 'https://warehouse.test',
        'content-type': 'application/json',
        cookie: `jw_session=${reviewer.token}; jw_csrf=${csrf}`,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ decision: 'approve', revision: product.revision }),
    }), { params: Promise.resolve({ id: product.id }) });
    assert.equal(reviewResponse.status, 409);
    const reviewPayload = await reviewResponse.json() as { error?: { code?: string; message?: string } };
    assert.equal(reviewPayload.error?.code, 'PRODUCT_NOT_READY');
    assert.match(reviewPayload.error?.message || '', /图片.*价格.*库存/);

    const emptyReasonHeaders = {
      origin: 'https://warehouse.test',
      'content-type': 'application/json',
      cookie: `jw_session=${reviewer.token}; jw_csrf=${csrf}`,
      'x-csrf-token': csrf,
    };
    const needsChangesResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${product.id}/decision`, {
      method: 'POST', headers: emptyReasonHeaders,
      body: JSON.stringify({ decision: 'needs_changes', reason: '', revision: product.revision }),
    }), { params: Promise.resolve({ id: product.id }) });
    assert.equal(needsChangesResponse.status, 200);
    const needsChangesPayload = await needsChangesResponse.json() as { data?: { product?: { status?: string } } };
    assert.equal(needsChangesPayload.data?.product?.status, 'needs_changes');

    const rejectedProductResponse = await createRoute(request(reviewer.token));
    assert.equal(rejectedProductResponse.status, 201);
    const rejectedProductPayload = await rejectedProductResponse.json() as { data?: { product?: { id?: string; revision?: number } } };
    const rejectedProduct = rejectedProductPayload.data?.product;
    assert.ok(rejectedProduct?.id);
    const rejectResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${rejectedProduct.id}/decision`, {
      method: 'POST', headers: emptyReasonHeaders,
      body: JSON.stringify({ decision: 'reject', reason: '', revision: rejectedProduct.revision }),
    }), { params: Promise.resolve({ id: rejectedProduct.id }) });
    assert.equal(rejectResponse.status, 200);
    const rejectPayload = await rejectResponse.json() as { data?: { product?: { status?: string } } };
    assert.equal(rejectPayload.data?.product?.status, 'rejected');
    const emptyReasons = db.prepare("SELECT decision, reason FROM review_decisions WHERE product_id IN (?, ?) ORDER BY decision").all(product.id, rejectedProduct.id) as Array<{ decision: string; reason: string | null }>;
    assert.deepEqual(emptyReasons.map((row) => [row.decision, row.reason]), [['needs_changes', null], ['reject', null]]);

    const completeProductBody = JSON.stringify({
      name: '完整人工商品', brand: '测试品牌', categoryId: category.id,
      description: '专业采购商品', ingredients: '测试成分', efficacy: '测试功效', directions: '测试用法', warnings: '测试注意事项',
      countryOfOrigin: '中国', manufacturer: '测试生产商', licenseNumber: 'XK-001', batchNumber: 'B20260816',
      productionDate: '2026-08-16', shelfLife: '3 年', expiryDate: '2029-08-15', notes: '仓库内部备注',
      assetIds: [preparedImage.id], publish: true,
      variants: [{ specification: '1000ml / 瓶', sku: 'MANUAL-ROUTE-1000', netContent: '1000ml', unit: '瓶', packaging: '瓶装', color: '白色', scent: '清香', price: 68, stock: 120 }],
    });
    const completeProductResponse = await createRoute(request(reviewer.token, {}, completeProductBody));
    assert.equal(completeProductResponse.status, 201);
    const completeProductPayload = await completeProductResponse.json() as { data?: { product?: { id?: string; revision?: number; entrySource?: string; status?: string } } };
    const completeProduct = completeProductPayload.data?.product;
    assert.ok(completeProduct?.id);
    const completeProductId = completeProduct.id;
    assert.equal(completeProduct.entrySource, 'manual');
    assert.equal(completeProduct.status, 'review_pending');
    assert.equal((db.prepare('SELECT COUNT(*) count FROM order_sync_outbox WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM review_decisions WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
    const completeRecord = getProduct(completeProduct.id);
    assert.ok(completeRecord);
    const assertReviewUnchanged = () => {
      const current = getProduct(completeProductId);
      assert.equal(current?.name, completeRecord.name);
      assert.equal(current?.variants[0]?.price, 68);
      assert.equal(current?.status, 'review_pending');
      assert.equal((db.prepare('SELECT COUNT(*) count FROM review_decisions WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) count FROM order_sync_outbox WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
    };
    for (const revision of [undefined, '1', 0, -1, 1.5]) {
      const invalidRevisionResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${completeProduct.id}/decision`, {
        method: 'POST', headers: emptyReasonHeaders,
        body: JSON.stringify({ decision: 'approve', ...(revision === undefined ? {} : { revision }) }),
      }), { params: Promise.resolve({ id: completeProduct.id }) });
      assert.equal(invalidRevisionResponse.status, 400);
      assertReviewUnchanged();
    }
    const staleRevisionResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${completeProduct.id}/decision`, {
      method: 'POST', headers: emptyReasonHeaders,
      body: JSON.stringify({ decision: 'approve', revision: (completeProduct.revision ?? 0) + 1 }),
    }), { params: Promise.resolve({ id: completeProduct.id }) });
    assert.equal(staleRevisionResponse.status, 409);
    const staleRevisionPayload = await staleRevisionResponse.json() as { error?: { code?: string } };
    assert.equal(staleRevisionPayload.error?.code, 'REVIEW_REVISION_CONFLICT');
    assertReviewUnchanged();
    const failedAtomicReview = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${completeProduct.id}/decision`, {
      method: 'POST', headers: emptyReasonHeaders,
      body: JSON.stringify({ decision: 'approve', revision: completeProduct.revision, product: { ...completeRecord, name: '不应半保存的名称', assetIds: [preparedImage.id], variants: completeRecord.variants.map((variant) => ({ ...variant, price: null })) } }),
    }), { params: Promise.resolve({ id: completeProduct.id }) });
    assert.equal(failedAtomicReview.status, 409);
    const afterFailedAtomicReview = getProduct(completeProduct.id);
    assert.equal(afterFailedAtomicReview?.name, completeRecord.name);
    assert.equal(afterFailedAtomicReview?.variants[0]?.price, 68);
    assert.equal(afterFailedAtomicReview?.status, 'review_pending');
    assert.equal((db.prepare('SELECT COUNT(*) count FROM review_decisions WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM order_sync_outbox WHERE product_id = ?').get(completeProduct.id) as { count: number }).count, 0);
    db.exec(`CREATE TRIGGER IF NOT EXISTS fail_review_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'review.approve' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
    const failedAuditReview = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${completeProduct.id}/decision`, {
      method: 'POST', headers: emptyReasonHeaders,
      body: JSON.stringify({ decision: 'approve', revision: completeProduct.revision, product: { ...completeRecord, name: '不应在审计失败后保存', assetIds: [preparedImage.id], variants: completeRecord.variants.map((variant) => ({ ...variant, price: 70 })) } }),
    }), { params: Promise.resolve({ id: completeProduct.id }) });
    assert.equal(failedAuditReview.status, 500);
    assertReviewUnchanged();
    db.exec('DROP TRIGGER fail_review_audit');
    const publishResponse = await reviewRoute(new Request(`https://warehouse.test/api/v1/review/items/${completeProduct.id}/decision`, {
      method: 'POST',
      headers: {
        origin: 'https://warehouse.test',
        'content-type': 'application/json',
        cookie: `jw_session=${reviewer.token}; jw_csrf=${csrf}`,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ decision: 'approve', revision: completeProduct.revision, product: { ...completeRecord, name: '审核后原子保存名称', assetIds: [preparedImage.id], variants: completeRecord.variants.map((variant) => ({ ...variant, price: 69 })) } }),
    }), { params: Promise.resolve({ id: completeProduct.id }) });
    assert.equal(publishResponse.status, 200);
    const publishPayload = await publishResponse.json() as { data?: { product?: { status?: string; publishedAssetIds?: string[] } } };
    assert.equal(publishPayload.data?.product?.status, 'published');
    assert.equal(getProduct(completeProduct.id)?.name, '审核后原子保存名称');
    assert.equal(getProduct(completeProduct.id)?.variants[0]?.price, 69);
    assert.deepEqual(publishPayload.data?.product?.publishedAssetIds, [preparedImage.id]);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM review_decisions WHERE product_id = ? AND decision = ?').get(completeProduct.id, 'approve') as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM order_sync_outbox WHERE product_id = ? AND status = ?').get(completeProduct.id, 'pending') as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM audit_log WHERE resource_id = ? AND action = ?').get(completeProduct.id, 'review.approve') as { count: number }).count, 1);
    resetPipelineRuntimeForTests();
  } finally {
    closeDb();
    restore('DATABASE_PATH', previous.database);
    restore('APP_ORIGIN', previous.origin);
    restore('REQUIRE_ORIGIN', previous.requireOrigin);
    restore('REQUIRE_CSRF', previous.requireCsrf);
    restore('NODE_ENV', previous.nodeEnv);
    restore('PIPELINE_MEDIA_ROOT', previous.mediaRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
