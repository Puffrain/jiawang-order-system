import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PipelineStore } from '../../lib/jobs/store';

const SERVICE_PATH = path.join(process.cwd(), 'lib', 'backup', 'service.ts');

async function serviceSource(): Promise<string> {
  return fs.readFile(SERVICE_PATH, 'utf8');
}

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return source.slice(from, to);
}

test('database restore is copied onto the live volume before the atomic pathname switch', async () => {
  const source = await serviceSource();
  const switchBlock = section(
    source,
    'async function switchDatabase(',
    '/** Restore the pre-switch database',
  );

  // `restoredPath` originates below BACKUP_OUT_DIR, which is a separate
  // Compose volume from the live SQLite file. Renaming it directly to the
  // live pathname fails with EXDEV and, worse, does so after live was moved.
  assert.doesNotMatch(
    switchBlock,
    /fsp\.rename\(\s*restoredPath\s*,\s*resolved\s*\)/,
    'never rename the extracted backup database directly across volumes',
  );

  // The publishable copy must be derived from the live pathname/directory,
  // copied before the switch, and then be the source of the final rename.
  assert.match(
    switchBlock,
    /(?:path\.dirname\(\s*resolved\s*\)|`\$\{resolved\}[^`]*(?:stage|staging|restore))/i,
    'same-volume staging must be located beside the live database',
  );
  assert.match(
    switchBlock,
    /fsp\.copyFile\(\s*restoredPath\s*,/,
    'the validated extracted database must be copied to same-volume staging',
  );
  assert.match(
    switchBlock,
    /fsp\.rename\(\s*(?!restoredPath\b)[A-Za-z_$][\w$]*\s*,\s*resolved\s*\)/,
    'the atomic publish must rename the same-volume staged copy',
  );
});

test('old-media deletion is post-commit GC and cannot enter restore rollback', async () => {
  const source = await serviceSource();
  const restoreBlock = section(
    source,
    'export async function processRestore(',
    '/** The portable snapshot intentionally omits restore_jobs.',
  );
  const gcBlock = section(
    source,
    'async function commitMediaRestore(',
    'async function waitForPipelineLeases(',
  );

  const logicalCommit = restoreBlock.indexOf('withMaintenanceTransaction(owner');
  const markTerminal = restoreBlock.indexOf('terminal = true', logicalCommit - 300);
  const runGc = restoreBlock.indexOf('commitMediaRestore(', logicalCommit);
  assert.ok(logicalCommit >= 0, 'restore completion must use the owner-aware maintenance transaction');
  assert.ok(markTerminal >= 0 && markTerminal < runGc, 'the logical commit boundary must precede media GC');
  assert.ok(runGc > logicalCommit, 'old-media cleanup must run only after the completed row is committed');

  // A partial GC may delete some `.pre-restore-*` files before another rm
  // fails. Throwing here would reach the outer catch and roll back the new
  // media generation even though old bytes have already been destroyed.
  assert.match(
    gcBlock,
    /Promise<MediaRestoreJournal>/,
    'GC must return the durable pending journal for retry',
  );
  assert.doesNotMatch(
    gcBlock,
    /throw\s+new\s+AggregateError/,
    'post-commit GC failures must remain retryable and must not throw into rollback',
  );
  assert.match(
    restoreBlock,
    /if\s*\(\s*mediaJournal\.length\s*\)[\s\S]{0,500}releaseMaintenance\s*=\s*false[\s\S]{0,300}return\s+getRestore\(id\)/,
    'pending GC must retain the maintenance fence and return the committed restore',
  );
});

test('pipeline lease drain checks all jobs, including an active lease on job 501', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-pipeline-lease-page-'));
  const store = new PipelineStore(path.join(root, 'state.json'));
  const now = Date.now();
  try {
    const leased = store.createJob({
      itemIds: [],
      totalItems: 0,
      provider: 'mock',
      reservedTokens: 0,
    });
    // Force the leased job behind the UI-oriented 500-row page.
    store.putJob({ ...leased, createdAt: '2000-01-01T00:00:00.000Z' });
    store.acquireJobLease(leased.id, 'worker:job-501', 60_000, now);
    for (let index = 0; index < 500; index += 1) {
      store.createJob({
        itemIds: [],
        totalItems: 0,
        provider: 'mock',
        reservedTokens: 0,
      });
    }

    assert.equal(
      store.listJobs(500).some((job) => Boolean(job.lease && Date.parse(job.lease.expiresAt) > now)),
      false,
      'fixture must place the active lease outside the first page',
    );
    assert.equal(store.hasActiveLeases(now), true);

    const source = await serviceSource();
    const waitBlock = section(
      source,
      'async function waitForPipelineLeases(',
      'function updateRestoreStatus(',
    );
    assert.match(waitBlock, /\.store\.hasActiveLeases\(/);
    assert.doesNotMatch(waitBlock, /\.store\.listJobs\(\s*500\s*\)/);
  } finally {
    await store.flush().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
