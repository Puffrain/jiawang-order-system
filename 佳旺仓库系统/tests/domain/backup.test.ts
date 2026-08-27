import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup } from '../../lib/backup/crypto';
import { sha256Hex, validateManifest } from '../../lib/backup/manifest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildArchive, extractArchive } from '../../lib/backup/archive';
import { decryptBackupFile, encryptBackupFile } from '../../lib/backup/crypto';

test('backup envelope encrypts and decrypts with authenticated data', async () => {
  const source = Buffer.from('佳旺商品库');
  const encrypted = await encryptBackup(source, 'a-strong-backup-password');
  assert.notDeepEqual(encrypted, source);
  assert.deepEqual(await decryptBackup(encrypted, 'a-strong-backup-password'), source);
  await assert.rejects(() => decryptBackup(encrypted, 'wrong-password'), /密码错误|损坏/);
});

test('manifest validates safe relative paths and hashes', () => {
  const manifest = {
    format: 'jwbackup', version: 1, appVersion: '0.1.0', schemaVersion: '1', createdAt: new Date().toISOString(),
    entries: [{ path: 'db/app.sqlite', bytes: 1, sha256: sha256Hex(Buffer.from('x')), kind: 'database' }],
  };
  assert.equal(validateManifest(manifest), true);
  assert.equal(validateManifest({ ...manifest, entries: [{ ...manifest.entries[0], path: '../escape' }] }), false);
});

test('large-backup streaming envelope round trips and rejects archive tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-backup-stream-'));
  try {
    const source = path.join(root, 'source.bin');
    await fs.writeFile(source, Buffer.from('streamed backup payload'));
    const archive = path.join(root, 'payload.archive');
    await buildArchive(archive, [{ path: 'media/source.bin', sourcePath: source, kind: 'original' }], { appVersion: 'test', schemaVersion: '001' });
    const envelope = path.join(root, 'payload.jwbackup');
    await encryptBackupFile(archive, envelope, 'streaming-backup-password');
    const decrypted = path.join(root, 'decrypted.archive');
    await decryptBackupFile(envelope, decrypted, 'streaming-backup-password');
    const extracted = path.join(root, 'extracted');
    await extractArchive(decrypted, extracted);
    assert.equal(await fs.readFile(path.join(extracted, 'media/source.bin'), 'utf8'), 'streamed backup payload');
    const bytes = await fs.readFile(envelope);
    bytes[bytes.length - 1] ^= 0xff;
    await fs.writeFile(envelope, bytes);
    await assert.rejects(() => decryptBackupFile(envelope, path.join(root, 'bad.archive'), 'streaming-backup-password'), /密码错误|损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
