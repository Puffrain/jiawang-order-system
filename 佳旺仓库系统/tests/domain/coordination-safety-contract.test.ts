import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function source(relative: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relative), 'utf8');
}

test('export attempts publish immutable generation paths with an owner-conditional commit', async () => {
  const service = await source('lib/export/service.ts');
  assert.match(service, /const output = path\.join\(root, `\$\{id\}\.\$\{attemptId\}\.\$\{extension\}`\)/);
  assert.match(service, /publishExportExclusive\(temp, output\)/);
  assert.match(service, /WHERE id=\? AND status='running' AND lease_owner=\?/);
  assert.doesNotMatch(service, /const output = path\.join\(root, `\$\{id\}\.\$\{extension\}`\)/);
  assert.doesNotMatch(service, /await fs\.rm\(output, \{ force: true \}\);\s*await fs\.rename\(temp, output\)/);
});

test('expired export cleanup uses a reclaimable owner fence', async () => {
  const service = await source('lib/export/service.ts');
  const migration = await source('migrations/017_export_cleanup_fence.sql');
  assert.match(migration, /cleanup_owner TEXT/);
  assert.match(migration, /cleanup_expires_at TEXT/);
  assert.match(service, /claimExpiredExport\(row\.id, cutoff, owner\)/);
  assert.match(service, /DELETE FROM export_jobs[\s\S]{0,200}cleanup_owner=\?/);
  assert.match(service, /withWriteLease\('export\.cleanup'/);
});

test('review projection conflicts become durable dead letters and are not falsely acknowledged', async () => {
  const sync = await source('lib/catalog/review-sync.ts');
  const route = await source('app/api/v1/reviews/route.ts');
  const migration = await source('migrations/016_review_sync_dead_letter.sql');
  assert.match(migration, /dead_letter_at TEXT/);
  assert.match(sync, /WHERE processed_at IS NULL AND dead_letter_at IS NULL/);
  assert.match(sync, /TERMINAL_ITEM_STATUSES\.has\(item\.status\)[\s\S]{0,200}markReviewSyncDeadLetter/);
  assert.match(sync, /nextAttempt >= MAX_REVIEW_SYNC_ATTEMPTS/);
  assert.match(route, /reviewSyncId && updated\.status === targetStatus/);
});

test('manual product image preparation is fenced from maintenance operations', async () => {
  const service = await source('lib/manual-product-media.ts');
  assert.match(service, /withWriteLease\('catalog\.manual_asset\.prepare'/);
  assert.match(service, /lease\.assertActive\(\)[\s\S]{0,500}deriveImage/);
  assert.match(service, /lease\.renew\(\)[\s\S]{0,200}putAsset/);
});

test('catalog product mutations participate in the durable write-lease fence', async () => {
  const repository = await source('lib/catalog-repository.ts');
  const maintenance = await source('lib/maintenance.ts');
  assert.match(maintenance, /export function withWriteLeaseSync/);
  assert.match(repository, /withWriteLeaseSync\('catalog\.product\.create'/);
  assert.match(repository, /withWriteLeaseSync\('catalog\.product\.update'/);
  assert.match(repository, /withWriteLeaseSync\('catalog\.product\.review'/);
});

test('manual and AI catalog entries keep distinct publication rules', async () => {
  const repository = await source('lib/catalog-repository.ts');
  const candidate = await source('lib/catalog/pipeline-candidate.ts');
  const migration = await source('migrations/020_product_entry_source.sql');
  assert.match(migration, /entry_source TEXT NOT NULL DEFAULT 'manual'/);
  assert.match(migration, /SET entry_source = 'ai'[\s\S]{0,100}source_group_id IS NOT NULL/);
  assert.match(candidate, /'ai', 'review_pending'/);
  assert.match(candidate, /assetIds: undefined/);
  assert.match(repository, /\.entrySource === 'manual' \? validateManualProductReadiness/);
  assert.match(repository, /人工商品至少需要一张已处理图片/);
  assert.match(repository, /必须填写价格/);
  assert.match(repository, /必须填写库存/);
});
