import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { closeDb, getDb, withMaintenanceTransaction, withTransaction } from '../db';
import { encryptSecret, decryptSecret } from '../crypto';
import { buildArchive, extractArchive, type ArchiveSource } from './archive';
import { encryptBackupFile, decryptBackupFile } from './crypto';
import { validateManifest, type BackupManifest } from './manifest';
import { getPipelineRuntime, resetPipelineRuntime } from '../jobs/runtime';
import { clearMaintenanceMode, enterMaintenanceMode, getMaintenanceState, isMaintenanceError, MaintenanceError, MAINTENANCE_SETTING_KEY, markMaintenanceManualRecovery, touchMaintenanceMode, waitForWriteLeases, withWriteLease } from '../maintenance';

export type BackupStatus = 'queued' | 'maintenance' | 'completed' | 'failed';
export type RestoreStatus = 'queued' | 'validating' | 'maintenance' | 'completed' | 'failed';

export interface BackupRecord {
  id: string;
  status: BackupStatus;
  requestedBy: string;
  outputPath: string | null;
  filename: string | null;
  manifest: BackupManifest | null;
  bytes: number | null;
  sha256: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  downloadable: boolean;
}

export interface RestoreRecord {
  id: string;
  status: RestoreStatus;
  requestedBy: string;
  recoveryBackupId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const MAX_BACKUP_BYTES = parseLimit('BACKUP_MAX_BYTES', 64 * 1024 * 1024 * 1024);
const MAX_RESTORE_BYTES = parseLimit('RESTORE_MAX_BYTES', 64 * 1024 * 1024 * 1024);

interface BackupProcessOptions {
  /** Existing maintenance owner for nested recovery backups. */
  maintenanceOwner?: string;
}

/** Durable sidecar written next to the live SQLite database before any
 * pathname is moved.  `lib/db.ts` deliberately treats an unexpected journal
 * as a fail-closed startup condition; the restore worker is the only code
 * allowed to remove it after a proven commit or rollback. */
export interface RestoreSwitchJournal {
  version: 1;
  restoreId: string;
  owner: string;
  phase: 'switching' | 'switched' | 'rollback_failed';
  livePath: string;
  restoredPath: string;
  rollbackPath: string;
  stagingPath: string;
  inputPath: string;
  recoveryBackupId: string | null;
  mediaMutations: Array<{
    target: string;
    previous: string | null;
    temp: string;
    state: 'planned' | 'previous_moved' | 'installed';
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Raised when automation cannot prove that it is safe to release the
 * maintenance fence.  Callers may surface `code` to an administrator, but
 * must not force-clear maintenance as part of generic error handling. */
export class RestoreManualRecoveryError extends Error {
  readonly code = 'RESTORE_MANUAL_RECOVERY';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RestoreManualRecoveryError';
  }
}

/** Typed failure boundary for the one-time backup download lease.  The
 * download route may safely expose the status/code, while filesystem paths
 * and lock contents remain server-side only. */
export class BackupDownloadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupDownloadError';
    this.code = code;
    this.status = status;
  }
}

interface BackupDownloadLock {
  version: 1;
  id: string;
  token: string;
  pid: number;
  phase: 'streaming' | 'finalizing' | 'done';
  path: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface BackupDownloadClaim {
  id: string;
  filename: string;
  bytes: number;
  sha256: string | null;
  /** Internal managed path. Never serialize this object into an API payload. */
  filePath: string;
  /** Refresh the durable download lock while a long response is streaming. */
  touch: () => Promise<void>;
  /** Stop the claim after a response/read failure; the canonical artifact is retained. */
  abort: () => Promise<void>;
  /** Commit a fully delivered response and consume the artifact. */
  complete: () => Promise<void>;
}

class DatabaseSwitchError extends RestoreManualRecoveryError {
  constructor(
    message: string,
    readonly switchInfo: DatabaseSwitch,
    readonly rollbackComplete: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DatabaseSwitchError';
  }
}

// Owners identify one execution attempt, not just one durable row. If two
// processes poll the same row concurrently, a deterministic row-only owner
// would make both calls look re-entrant and allow duplicate backup/restore
// work. A crashed attempt remains visible as a different owner until an
// operator explicitly clears that maintenance marker.
function operationOwner(kind: 'backup' | 'restore', id: string): string {
  return `${kind}:${id}:${process.pid}:${randomUUID()}`;
}

function restoreOperationOwner(id: string, status: unknown): string {
  // A restart after a pathname switch must continue under the durable owner
  // encoded in the replacement database's maintenance marker.  Reusing that
  // fenced token lets the worker renew/finish the same operation instead of
  // racing a second restore attempt.  Other markers are never borrowed.
  if (status === 'validating' || status === 'maintenance') {
    try {
      const state = getMaintenanceState();
      if (state.active && !state.manualRecoveryRequired && state.owner && state.owner.startsWith(`restore:${id}:`)) {
        return state.owner;
      }
    } catch { /* let the normal owner acquisition surface the DB failure */ }
  }
  return operationOwner('restore', id);
}

/** Enter maintenance unless the same owner already holds the marker.  The
 * boolean lets nested operations leave the outer owner's marker untouched. */
function beginMaintenance(owner: string, reason: string): boolean {
  const current = getMaintenanceState();
  if (current.active) {
    if (current.owner !== owner) {
      // A worker may reclaim only its own durable operation after a crash.
      // Never let a backup for one row steal a restore (or another backup)
      // merely because the other marker looks stale.
      const requested = operationIdentity(owner);
      const held = operationIdentity(current.owner || '');
      if (!requested || !held || requested.kind !== held.kind || requested.id !== held.id) {
        throw new MaintenanceError('维护模式由其他备份/恢复任务持有', 'MAINTENANCE_BUSY', 409);
      }
      // Let the shared helper provide the typed conflict/status contract (and
      // perform one atomic re-check) instead of manufacturing a plain Error.
      const acquired = enterMaintenanceMode(owner, reason);
      return acquired.owner === owner;
    }
    return false;
  }
  enterMaintenanceMode(owner, reason);
  return true;
}

function operationIdentity(owner: string): { kind: 'backup' | 'restore'; id: string } | null {
  const match = /^(backup|restore):([^:]+):/.exec(owner);
  return match ? { kind: match[1] as 'backup' | 'restore', id: match[2] } : null;
}

function endMaintenance(owner: string, acquired: boolean): void {
  if (!acquired) return;
  try {
    // A heartbeat/fencing failure deliberately turns the marker into a
    // manual-recovery latch.  Even the original owner must not clear it in a
    // generic finally block.
    if (getMaintenanceState().manualRecoveryRequired) return;
    clearMaintenanceMode(owner);
  } catch { /* preserve the operation result */ }
}

interface MaintenanceHeartbeat {
  stop: () => void;
  assertOwned: () => void;
}

function startMaintenanceHeartbeat(owner: string): MaintenanceHeartbeat {
  let fencingError: RestoreManualRecoveryError | null = null;
  const timer = setInterval(() => {
    try {
      const renewed = touchMaintenanceMode(owner);
      if (!renewed) throw new Error('维护租约已丢失');
    } catch (error) {
      fencingError = new RestoreManualRecoveryError('维护租约已丢失，操作已锁定为人工恢复', { cause: error });
      try {
        const state = getMaintenanceState();
        if (state.active && state.owner === owner) markMaintenanceManualRecovery(owner, fencingError.message);
      } catch { /* preserve the fence even if SQLite is unavailable */ }
    }
  }, 10_000);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    assertOwned: () => {
      if (fencingError) throw fencingError;
      const state = getMaintenanceState();
      if (!state.active || state.owner !== owner || state.manualRecoveryRequired) {
        const error = new RestoreManualRecoveryError('维护租约已丢失，操作已锁定为人工恢复');
        try {
          if (state.active && state.owner === owner) markMaintenanceManualRecovery(owner, error.message);
        } catch { /* fail closed in the caller's finally */ }
        throw error;
      }
    },
  };
}

function backupRoot(): string {
  const configured = process.env.BACKUP_OUT_DIR?.trim() || path.join(process.cwd(), '.local', 'backups');
  const resolved = path.resolve(configured);
  if (process.env.NODE_ENV === 'production' && /(?:OneDrive|\\\\|SMB|network)/i.test(resolved)) {
    throw new Error('生产环境备份目录不得位于 OneDrive 或网络盘');
  }
  return resolved;
}

export async function backupInputRoot(): Promise<string> {
  const root = path.join(backupRoot(), '.incoming');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function mediaRoot(): string {
  return path.resolve(process.env.PIPELINE_MEDIA_ROOT?.trim() || process.env.MEDIA_ROOT?.trim() || path.join(process.cwd(), 'data', 'media'));
}

function now(): string { return new Date().toISOString(); }

function mapBackup(row: Record<string, unknown>): BackupRecord {
  let manifest: BackupManifest | null = null;
  if (typeof row.manifest_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.manifest_json);
      if (validateManifest(parsed)) manifest = parsed;
    } catch { /* corrupt metadata is reported as null, never exposed raw */ }
  }
  // Never expose the absolute storage path to API callers.  Internal callers
  // reconstruct the managed path from the opaque job id and basename.
  const rawOutputPath = row.output_path == null ? null : String(row.output_path);
  const outputPath = rawOutputPath ? path.basename(rawOutputPath) : null;
  return {
    id: String(row.id),
    status: row.status as BackupStatus,
    requestedBy: String(row.requested_by),
    outputPath,
    filename: outputPath ? path.basename(outputPath) : null,
    manifest,
    bytes: row.bytes == null ? null : Number(row.bytes),
    sha256: row.sha256 == null ? null : String(row.sha256),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    downloadable: row.status === 'completed' && Boolean(outputPath),
  };
}

function mapRestore(row: Record<string, unknown>): RestoreRecord {
  return {
    id: String(row.id),
    status: row.status as RestoreStatus,
    requestedBy: String(row.requested_by),
    recoveryBackupId: row.recovery_backup_id == null ? null : String(row.recovery_backup_id),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export function listBackups(limit = 100): BackupRecord[] {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
  const rows = getDb().prepare('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT ?').all(bounded) as Record<string, unknown>[];
  return rows.map(mapBackup);
}

export function getBackup(id: string): BackupRecord | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const row = getDb().prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapBackup(row) : null;
}

export function assertBackupPath(record: BackupRecord): string {
  if (!record.outputPath || record.status !== 'completed') throw new Error('备份文件尚未生成');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(record.id) || path.basename(record.outputPath) !== `${record.id}.jwbackup`) throw new Error('备份路径无效');
  const root = path.resolve(backupRoot());
  const resolved = path.resolve(root, `${record.id}.jwbackup`);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('备份路径无效');
  return resolved;
}

const DOWNLOAD_LOCK_TTL_MS = boundedDownloadLockTtl();

/** Acquire a durable, no-clobber download claim.  The canonical backup file
 * remains at its published pathname throughout streaming; only the lock is
 * moved through phases.  This means a worker crash before finalization never
 * leaves SQLite pointing at a missing file. */
export async function beginBackupDownload(id: string): Promise<BackupDownloadClaim> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new BackupDownloadError('NOT_FOUND', '备份不存在', 404);
  const root = backupRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = path.join(root, `${id}.jwbackup`);
  const lockFile = downloadLockPath(root, id);

  // Reconcile a previous process that crashed after setting finalizing.  This
  // is intentionally performed before the new exclusive lock attempt.
  await recoverDownloadLockIfNeeded(id, canonical, lockFile);

  const token = `${process.pid}:${randomUUID()}`;
  const timestamp = now();
  const lock: BackupDownloadLock = {
    version: 1,
    id,
    token,
    pid: process.pid,
    phase: 'streaming',
    path: canonical,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(Date.now() + DOWNLOAD_LOCK_TTL_MS).toISOString(),
  };
  try {
    await writeDownloadLock(lockFile, lock, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readDownloadLock(lockFile);
    if (isDownloadLockExpired(existing)) {
      await recoverDownloadLockIfNeeded(id, canonical, lockFile);
      await writeDownloadLock(lockFile, lock, true);
    } else {
      throw new BackupDownloadError('BACKUP_DOWNLOAD_BUSY', '备份正在被其他请求下载，请稍后重试', 409);
    }
  }

  try {
    const row = getDb().prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'completed' || row.output_path == null) throw new BackupDownloadError('NOT_FOUND', '备份不存在或尚未完成', 404);
    assertStoredBackupPath(row, canonical, id);
    const stat = await fsp.lstat(canonical);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new BackupDownloadError('BACKUP_INTEGRITY', '备份文件不是普通文件', 409);
    const bytes = Number(row.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || stat.size !== bytes) throw new BackupDownloadError('BACKUP_INTEGRITY', '备份文件大小校验失败', 409);
    const sha256 = row.sha256 == null ? null : String(row.sha256).toLowerCase();
    if (sha256 && await hashFile(canonical) !== sha256) throw new BackupDownloadError('BACKUP_INTEGRITY', '备份文件哈希校验失败', 409);
    let closed = false;
    const touch = async (): Promise<void> => {
      if (closed) return;
      const current = await readDownloadLock(lockFile);
      if (!current || current.token !== token || current.phase !== 'streaming') throw new BackupDownloadError('BACKUP_DOWNLOAD_FENCED', '备份下载租约已失效', 409);
      await writeDownloadLock(lockFile, { ...current, updatedAt: now(), expiresAt: new Date(Date.now() + DOWNLOAD_LOCK_TTL_MS).toISOString() });
    };
    const abort = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const current = await readDownloadLock(lockFile).catch(() => null);
      if (current?.token === token && current.phase === 'streaming') await removeDownloadLock(lockFile, token);
    };
    const complete = async (): Promise<void> => {
      if (closed) return;
      const current = await readDownloadLock(lockFile);
      if (!current || current.token !== token || current.phase !== 'streaming') throw new BackupDownloadError('BACKUP_DOWNLOAD_FENCED', '备份下载租约已失效', 409);
      await writeDownloadLock(lockFile, { ...current, phase: 'finalizing', updatedAt: now(), expiresAt: new Date(Date.now() + DOWNLOAD_LOCK_TTL_MS).toISOString() });
      await withWriteLease('backup.download.finalize', async (lease) => {
        lease.assertActive();
        const claimed = withTransaction((db) => db.prepare("UPDATE backup_jobs SET output_path = NULL, updated_at = ? WHERE id = ? AND status = 'completed' AND output_path IS NOT NULL").run(now(), id));
        if (claimed.changes !== 1) throw new BackupDownloadError('BACKUP_DOWNLOAD_CONFLICT', '备份状态已变化，文件暂未清理', 409);
        try {
          await fsp.rm(canonical, { force: false });
          lease.assertActive();
        } catch (error) {
          // Keep the finalizing lock. Recovery will restore output_path while
          // the canonical bytes still exist, so a cleanup failure cannot lose
          // the only copy.
          throw new BackupDownloadError('BACKUP_DOWNLOAD_CLEANUP_PENDING', '备份已发送但清理尚未完成，请稍后重试', 503, { cause: error });
        }
        closed = true;
        await writeDownloadLock(lockFile, { ...current, phase: 'done', updatedAt: now(), expiresAt: new Date(Date.now() + DOWNLOAD_LOCK_TTL_MS).toISOString() }).catch(() => undefined);
        await removeDownloadLock(lockFile, token).catch(() => undefined);
      }, { ttlMs: DOWNLOAD_LOCK_TTL_MS });
    };
    return { id, filename: `${id}.jwbackup`, bytes, sha256, filePath: canonical, touch, abort, complete };
  } catch (error) {
    await removeDownloadLock(lockFile, token).catch(() => undefined);
    throw error;
  }
}

function assertStoredBackupPath(row: Record<string, unknown>, canonical: string, id: string): void {
  const raw = row.output_path == null ? '' : String(row.output_path);
  if (!raw || path.basename(raw) !== `${id}.jwbackup`) throw new BackupDownloadError('BACKUP_PATH', '备份路径无效', 409);
  if (path.isAbsolute(raw) && path.resolve(raw) !== path.resolve(canonical)) throw new BackupDownloadError('BACKUP_PATH', '备份路径无效', 409);
}

async function recoverDownloadLockIfNeeded(id: string, canonical: string, lockFile: string): Promise<void> {
  const existing = await readDownloadLock(lockFile).catch((error) => {
    if (error instanceof BackupDownloadError && error.code === 'BACKUP_DOWNLOAD_NOT_FOUND') return null;
    throw error;
  });
  if (!existing) return;
  if (existing.id !== id || path.resolve(existing.path) !== path.resolve(canonical)) throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载锁与任务不匹配，请管理员处理', 503);
  // finalizing/done are live ownership phases too. Recovering either before
  // expiry can restore output_path while the original owner is deleting the
  // canonical bytes, leaving SQLite pointed at a missing file.
  if (!isDownloadLockExpired(existing)) throw new BackupDownloadError('BACKUP_DOWNLOAD_BUSY', '备份正在被其他请求下载，请稍后重试', 409);
  if (existing.phase === 'streaming' && isDownloadLockExpired(existing)) {
    await removeDownloadLock(lockFile, existing.token);
    return;
  }
  await withWriteLease('backup.download.recover', async (lease) => {
    lease.assertActive();
    const row = getDb().prepare('SELECT status, output_path FROM backup_jobs WHERE id = ?').get(id) as { status?: string; output_path?: unknown } | undefined;
    if (!row || row.status !== 'completed') throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载状态无法恢复，请管理员处理', 503);
    const stat = await fsp.lstat(canonical).catch(() => undefined);
    const canonicalFile = Boolean(stat?.isFile() && !stat.isSymbolicLink());
    if (row.output_path == null && canonicalFile) {
      // Recovery is fail-closed: do not remove the durable lock unless the
      // database state was actually reconciled. A zero-row CAS can mean that
      // another worker changed the row between the read above and this update;
      // blindly deleting the lock in that case could expose an inconsistent
      // artifact to a concurrent downloader.
      const restored = withTransaction((db) => db.prepare("UPDATE backup_jobs SET output_path = ?, updated_at = ? WHERE id = ? AND status = 'completed' AND output_path IS NULL").run(canonical, now(), id));
      if (restored.changes !== 1) {
        throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载状态无法恢复，请管理员处理', 503);
      }
    } else if (row.output_path != null && !canonicalFile) {
      throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载锁定期间文件丢失，请管理员处理', 503);
    }
    lease.assertActive();
  }, { ttlMs: DOWNLOAD_LOCK_TTL_MS });
  await removeDownloadLock(lockFile, existing.token).catch(() => undefined);
}

async function readDownloadLock(lockFile: string): Promise<BackupDownloadLock> {
  const stat = await fsp.lstat(lockFile).catch(() => undefined);
  if (!stat) throw new BackupDownloadError('BACKUP_DOWNLOAD_NOT_FOUND', '下载锁不存在', 404);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载锁无效，请管理员处理', 503);
  let parsed: unknown;
  try { parsed = JSON.parse(await fsp.readFile(lockFile, 'utf8')); } catch (error) { throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载锁损坏，请管理员处理', 503, { cause: error }); }
  const value = parsed as Partial<BackupDownloadLock>;
  if (value.version !== 1 || typeof value.id !== 'string' || typeof value.token !== 'string' || !Number.isInteger(value.pid)
    || !['streaming', 'finalizing', 'done'].includes(String(value.phase)) || typeof value.path !== 'string'
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.expiresAt !== 'string') {
    throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '备份下载锁格式无效，请管理员处理', 503);
  }
  return value as BackupDownloadLock;
}

async function writeDownloadLock(lockFile: string, lock: BackupDownloadLock, exclusive = false): Promise<void> {
  const flags = exclusive ? 'wx' : 'r+';
  const handle = await fsp.open(lockFile, flags, 0o600);
  try {
    if (!exclusive) await handle.truncate(0);
    await handle.write(`${JSON.stringify(lock)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

async function removeDownloadLock(lockFile: string, expectedToken?: string): Promise<void> {
  const quarantine = `${lockFile}.remove-${randomUUID()}`;
  try {
    // Move the exact inode away first. A replacement lock created at the
    // canonical pathname after this rename is never touched by the cleanup.
    await fsp.rename(lockFile, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readDownloadLock(quarantine);
  if (expectedToken && moved.token !== expectedToken) {
    // We isolated a newer owner's inode. Restore it only through an
    // exclusive hard-link/copy; never rename over a lock that appeared while
    // this operation was in flight. If restoration cannot be proven, retain
    // the quarantined lock for explicit administrator recovery.
    try {
      await restoreQuarantinedDownloadLock(quarantine, lockFile);
    } catch (error) {
      throw new BackupDownloadError('BACKUP_DOWNLOAD_RECOVERY', '下载锁所有权发生冲突，请管理员处理', 503, { cause: error });
    }
    return;
  }
  await fsp.rm(quarantine, { force: false });
}

async function restoreQuarantinedDownloadLock(quarantine: string, lockFile: string): Promise<void> {
  try {
    await fsp.link(quarantine, lockFile);
    await fsp.rm(quarantine, { force: false });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EEXIST'].includes(String(code))) throw error;
    if (code === 'EEXIST') {
      const current = await readDownloadLock(lockFile);
      const moved = await readDownloadLock(quarantine);
      if (current.token === moved.token) {
        await fsp.rm(quarantine, { force: false });
        return;
      }
      throw new Error('下载锁恢复目标已被其他 owner 占用');
    }
    await fsp.copyFile(quarantine, lockFile, fs.constants.COPYFILE_EXCL);
    await fsp.rm(quarantine, { force: false });
  }
}

function downloadLockPath(root: string, id: string): string { return path.join(root, `.${id}.download.lock`); }
function isDownloadLockExpired(lock: BackupDownloadLock): boolean {
  const expiry = Date.parse(lock.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}
function boundedDownloadLockTtl(): number {
  const value = Number(process.env.BACKUP_DOWNLOAD_LOCK_TTL_MS);
  return Number.isSafeInteger(value) && value >= 60_000 && value <= 24 * 60 * 60 * 1000 ? value : 30 * 60 * 1000;
}

/** Persist a queued backup request without touching live data. */
export function enqueueBackup(
  passphrase: string,
  requestedBy: string,
  options: BackupProcessOptions = {},
): BackupRecord {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 512) throw new Error('备份密码长度必须在 12-512 个字符之间');
  const id = `backup-${randomUUID()}`;
  const timestamp = now();
  const encrypted = encryptSecret(passphrase);
  const persist = (db: Database.Database) => {
    db.prepare(`INSERT INTO backup_jobs (id, status, requested_by, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?)`).run(id, requestedBy, timestamp, timestamp);
    db.prepare('INSERT INTO backup_secrets (backup_job_id, encrypted_passphrase, created_at) VALUES (?, ?, ?)').run(id, encrypted, timestamp);
  };
  // A restore creates its pre-switch safety copy while it already owns the
  // maintenance fence.  Only that exact durable owner may use the explicit
  // escape hatch; external/admin requests continue to use the normal fenced
  // transaction and are rejected while maintenance is active.
  if (options.maintenanceOwner) withMaintenanceTransaction(options.maintenanceOwner, persist);
  else withTransaction(persist);
  return getBackup(id)!;
}

/** Queue and process a backup synchronously for trusted/internal callers. */
export async function createBackup(passphrase: string, requestedBy: string, options: BackupProcessOptions = {}): Promise<BackupRecord> {
  const queued = enqueueBackup(passphrase, requestedBy, options);
  await processBackup(queued.id, options);
  return getBackup(queued.id)!;
}

export async function processQueuedBackups(limit = 1): Promise<BackupRecord[]> {
  // A worker may crash after claiming a row (status=maintenance). Include
  // those recoverable claims on the next poll; processBackup reacquires the
  // owner-aware maintenance marker before doing any work.
  const rows = getDb().prepare("SELECT id FROM backup_jobs WHERE status IN ('queued', 'maintenance') ORDER BY created_at ASC LIMIT ?").all(Math.min(Math.max(limit, 1), 10)) as Array<{ id: string }>;
  const result: BackupRecord[] = [];
  for (const row of rows) {
    await processBackup(row.id);
    const backup = getBackup(row.id);
    if (backup) result.push(backup);
  }
  return result;
}

export async function processBackup(id: string, options: BackupProcessOptions = {}): Promise<BackupRecord> {
  const row = getDb().prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('备份任务不存在');
  if (row.status === 'completed') return mapBackup(row);
  if (row.status !== 'queued' && row.status !== 'maintenance') return mapBackup(row);
  const owner = options.maintenanceOwner || operationOwner('backup', id);
  const acquiredMaintenance = beginMaintenance(owner, `备份任务 ${id} 正在执行`);
  const heartbeat = startMaintenanceHeartbeat(owner);
  let claimed = false;
  let staging: string | undefined;
  let outputPath: string | undefined;
  try {
    // Claim the durable row after entering maintenance.  A second worker that
    // races this call observes the conditional update and leaves the row to
    // the winner instead of rebuilding the same archive.
    if (row.status === 'queued') {
      const claim = withMaintenanceTransaction(owner, (db) => db.prepare("UPDATE backup_jobs SET status = 'maintenance', updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), id));
      claimed = claim.changes === 1;
      if (!claimed) {
        endMaintenance(owner, acquiredMaintenance);
        return getBackup(id)!;
      }
    } else {
      const state = getMaintenanceState();
      if (!state.active || state.owner !== owner) throw new Error('备份任务正在由其他进程处理');
      claimed = true;
    }
    const secretRow = getDb().prepare('SELECT encrypted_passphrase FROM backup_secrets WHERE backup_job_id = ?').get(id) as { encrypted_passphrase: string } | undefined;
    if (!secretRow) throw new Error('备份密码已过期，请重新创建备份');
    const passphrase = decryptSecret(secretRow.encrypted_passphrase);
    const rootPath = backupRoot();
    await fsp.mkdir(rootPath, { recursive: true, mode: 0o700 });
    staging = await fsp.mkdtemp(path.join(rootPath, `.staging-${id}-`));
    const archivePath = path.join(staging, `${id}.archive`);
    outputPath = path.join(rootPath, `${id}.jwbackup`);
    heartbeat.assertOwned();
    await waitForWriteLeases({ maintenanceOwner: owner });
    await waitForPipelineLeases();
    heartbeat.assertOwned();
    const sources = await snapshotSources(staging);
    const manifest = await buildArchive(archivePath, sources, {
      appVersion: readAppVersion(),
      schemaVersion: latestSchemaVersion(),
    });
    const declaredBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_BACKUP_BYTES) throw new Error('备份内容超过配置的大小限制');
    heartbeat.assertOwned();
    // A previous attempt may have published a ciphertext before SQLite was
    // able to mark the row completed.  Never overwrite or delete that byteset
    // on retry: quarantine it under an exclusive, auditable name and publish
    // the new envelope only through encryptBackupFile()'s no-clobber commit.
    await quarantineExistingBackupOutput(outputPath, id);
    await encryptBackupFile(archivePath, outputPath, passphrase);
    const outputStat = await fsp.stat(outputPath);
    const digest = await hashFile(outputPath);
    const completed = now();
    heartbeat.assertOwned();
    withMaintenanceTransaction(owner, (db) => {
      db.prepare('UPDATE backup_jobs SET status = \'completed\', manifest_json = ?, output_path = ?, bytes = ?, sha256 = ?, updated_at = ?, completed_at = ?, error_message = NULL WHERE id = ?')
        .run(JSON.stringify(manifest), outputPath, outputStat.size, digest, completed, completed, id);
      db.prepare('DELETE FROM backup_secrets WHERE backup_job_id = ?').run(id);
    });
    return getBackup(id)!;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : '备份失败';
    // Persist terminal failure even when setup (decrypting the passphrase,
    // creating the staging directory, or resolving the output root) fails
    // before an archive path exists. If SQLite itself is unavailable, retain
    // the durable row/secret for operator recovery rather than masking the
    // original error with a second database exception.
    // A maintenance conflict can happen before this worker conditionally
    // claims a queued row.  Never mark another worker's queued/maintenance
    // attempt as failed; leave it durable for its owner or a later retry.
    if (claimed) {
      try {
        withMaintenanceTransaction(owner, (db) => {
          db.prepare('UPDATE backup_jobs SET status = \'failed\', error_message = ?, updated_at = ? WHERE id = ?').run(message, now(), id);
          db.prepare('DELETE FROM backup_secrets WHERE backup_job_id = ?').run(id);
        });
      } catch { /* preserve the original failure and maintenance marker */ }
    }
    throw error;
  } finally {
    if (staging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    heartbeat.stop();
    endMaintenance(owner, acquiredMaintenance);
  }
}

export function listRestores(limit = 100): RestoreRecord[] {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
  return (getDb().prepare('SELECT * FROM restore_jobs ORDER BY created_at DESC LIMIT ?').all(bounded) as Record<string, unknown>[]).map(mapRestore);
}

export function getRestore(id: string): RestoreRecord | null {
  const row = getDb().prepare('SELECT * FROM restore_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapRestore(row) : null;
}

/** Persist a restore request and retain its encrypted envelope for the worker. */
export async function enqueueRestore(inputPath: string, passphrase: string, requestedBy: string): Promise<RestoreRecord> {
  const stat = await fsp.stat(inputPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RESTORE_BYTES) throw new Error('恢复包大小无效');
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 512) throw new Error('恢复密码长度必须在 12-512 个字符之间');
  const incomingRoot = await backupInputRoot();
  const retainedPath = path.join(incomingRoot, `.restore-${process.pid}-${randomUUID()}.jwbackup`);
  await fsp.copyFile(path.resolve(inputPath), retainedPath, fs.constants.COPYFILE_EXCL);
  try {
    const retainedStat = await fsp.stat(retainedPath);
    if (!retainedStat.isFile() || retainedStat.size <= 0 || retainedStat.size > MAX_RESTORE_BYTES) throw new Error('恢复包大小无效');
    const id = `restore-${randomUUID()}`;
    const timestamp = now();
    const encrypted = encryptSecret(passphrase);
    withTransaction((db) => {
      db.prepare('INSERT INTO restore_jobs (id, status, requested_by, input_path, passphrase_ciphertext, created_at, updated_at) VALUES (?, \'queued\', ?, ?, ?, ?, ?)').run(id, requestedBy, retainedPath, encrypted, timestamp, timestamp);
    });
    return getRestore(id)!;
  } catch (error) {
    await fsp.rm(retainedPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Restore an uploaded envelope synchronously for trusted/internal callers. */
export async function restoreBackup(inputPath: string, passphrase: string, requestedBy: string): Promise<RestoreRecord> {
  const queued = await enqueueRestore(inputPath, passphrase, requestedBy);
  await processRestore(queued.id);
  return getRestore(queued.id)!;
}

export async function processQueuedRestores(limit = 1): Promise<RestoreRecord[]> {
  // validating/maintenance rows are resumable checkpoints left by a worker
  // that may have been terminated between durable transitions. A fresh
  // maintenance claim is still required inside processRestore.
  await recoverCompletedRestoreFence();
  const rows = getDb().prepare("SELECT id FROM restore_jobs WHERE status IN ('queued', 'validating', 'maintenance') ORDER BY created_at ASC LIMIT ?").all(Math.min(Math.max(limit, 1), 10)) as Array<{ id: string }>;
  const result: RestoreRecord[] = [];
  for (const row of rows) {
    try { await processRestore(row.id); }
    catch (error) {
      if (isMaintenanceError(error)) break;
    }
    const restore = getRestore(row.id);
    if (restore) result.push(restore);
  }
  return result;
}

export async function processRestore(id: string): Promise<RestoreRecord> {
  const row = getDb().prepare('SELECT * FROM restore_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('恢复任务不存在');
  if (row.status === 'completed') {
    await recoverCompletedRestoreFence(id);
    return getRestore(id) || mapRestore(row);
  }
  if (row.status !== 'queued' && row.status !== 'validating' && row.status !== 'maintenance') return mapRestore(row);
  const owner = restoreOperationOwner(id, row.status);
  let maintenanceAcquired = false;
  const retainedInputPath = String(row.input_path);
  let passphrase = '';
  let staging: string | undefined;
  let recoveryBackupId: string | null = null;
  let recoveryBackup: BackupRecord | null = null;
  let switchAttempted = false;
  let switchInfo: DatabaseSwitch | null = null;
  let switchJournal: RestoreSwitchJournal | null = null;
  let switchRolledBack = false;
  let mediaJournal: MediaRestoreJournal | null = null;
  let terminal = false;
  let releaseMaintenance = true;
  try {
    const stateBeforeClaim = getMaintenanceState();
    const resumingDurableOwner = row.status !== 'queued'
      && stateBeforeClaim.active
      && stateBeforeClaim.owner === owner
      && !stateBeforeClaim.manualRecoveryRequired;
    maintenanceAcquired = beginMaintenance(owner, `restore:${id}`) || resumingDurableOwner;
    const heartbeat = startMaintenanceHeartbeat(owner);
    try {
    if (row.status === 'queued') {
      // Claim queued rows conditionally. This closes the small race between
      // entering maintenance and writing the durable validating state.
      const claim = withMaintenanceTransaction(owner, (db) => db.prepare("UPDATE restore_jobs SET status = 'validating', updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), id));
      if (claim.changes !== 1) {
        const current = getRestore(id);
        terminal = current?.status === 'completed' || current?.status === 'failed';
        return current || mapRestore(row);
      }
    } else {
      // A non-queued row can only be resumed after a previous owner released
      // the marker. If another live attempt still owns it, do not duplicate
      // decryption/snapshot/media work.
      const state = getMaintenanceState();
      if (!state.active || state.owner !== owner || state.manualRecoveryRequired) {
        throw new RestoreManualRecoveryError('恢复任务维护租约无法安全接管');
      }
      updateRestoreStatus(id, 'validating', owner);
    }
    heartbeat.assertOwned();
    await waitForWriteLeases({ maintenanceOwner: owner });
    await waitForPipelineLeases();
    heartbeat.assertOwned();
    const root = backupRoot();
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    let extracted: string | undefined;
    let databasePath: string | undefined;
    let resumedAfterSwitch = false;
    const pendingJournal = await findRestoreSwitchJournalForCurrentDatabase(id);
    if (pendingJournal) {
      // A process can die after the replacement inode is published but before
      // ensureRestoreRowAfterSwitch() runs.  The staged database already has
      // the row/marker, so resume from its durable staging directory instead
      // of taking a second recovery backup and switching again.
      if (pendingJournal.phase === 'rollback_failed') {
        throw new RestoreManualRecoveryError('恢复 journal 标记为回滚失败，必须人工恢复');
      }
      const switched = await journalHasPublishedReplacement(pendingJournal);
      if (!switched) {
        // The journal was written but no pathname move happened.  It is safe
        // to discard this attempt and continue with a fresh staging area.
        await removeRestoreSwitchJournal(pendingJournal.livePath + '.restore-journal.json', id);
        await fsp.rm(pendingJournal.stagingPath, { recursive: true, force: true }).catch(() => undefined);
      } else {
        const managedRoot = path.resolve(root);
        const managedStaging = path.resolve(pendingJournal.stagingPath);
        if (!managedStaging.startsWith(`${managedRoot}${path.sep}`)) throw new RestoreManualRecoveryError('恢复 staging 路径不受管理');
        if (path.resolve(pendingJournal.inputPath) !== path.resolve(retainedInputPath)) throw new RestoreManualRecoveryError('恢复输入与 journal 不匹配');
        const stat = await fsp.lstat(managedStaging).catch(() => undefined);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new RestoreManualRecoveryError('恢复 staging 缺失，必须人工恢复');
        staging = managedStaging;
        extracted = path.join(staging, 'extracted');
        databasePath = pendingJournal.livePath;
        switchJournal = pendingJournal;
        switchInfo = { livePath: pendingJournal.livePath, rollbackPath: pendingJournal.rollbackPath, journalPath: restoreJournalPath(pendingJournal.livePath) };
        switchAttempted = true;
        switchRolledBack = false;
        recoveryBackupId = pendingJournal.recoveryBackupId || (row.recovery_backup_id == null ? null : String(row.recovery_backup_id));
        recoveryBackup = recoveryBackupId ? getBackup(recoveryBackupId) : null;
        if (!recoveryBackup) throw new RestoreManualRecoveryError('恢复留底备份记录缺失，必须人工恢复');
        await validateRestoredDatabase(databasePath);
        await validateRestoredMediaReferences(databasePath, extracted);
        resumedAfterSwitch = true;
        // Fence a stale owner takeover by rewriting the sidecar owner before
        // any media/database mutation.  The replacement DB marker is updated
        // by beginMaintenance()/the heartbeat under the same owner token.
        if (pendingJournal.owner !== owner) {
          switchJournal = { ...pendingJournal, owner, updatedAt: now() };
          await writeRestoreSwitchJournal(switchJournal, switchInfo.journalPath);
        }
      }
    }
    if (!resumedAfterSwitch) {
      passphrase = decryptSecret(String(row.passphrase_ciphertext));
      staging = await fsp.mkdtemp(path.join(root, `.restore-${id}-`));
      const plaintext = path.join(staging, 'payload.archive');
      extracted = path.join(staging, 'extracted');
      databasePath = path.join(extracted, 'database', 'app.sqlite');
      await decryptBackupFile(String(row.input_path), plaintext, passphrase, MAX_RESTORE_BYTES);
      const manifest = await extractArchive(plaintext, extracted, { maxTotalBytes: MAX_RESTORE_BYTES });
      assertRestoreCompatibility(manifest);
      await validateRestoredDatabase(databasePath);
      const metadataPath = path.join(extracted, 'metadata', 'system.json');
      if (!(await exists(metadataPath))) throw new Error('备份缺少系统元数据');
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as { mediaRoot?: string; appVersion?: string; schemaVersion?: string };
      if (metadata.appVersion !== undefined && metadata.schemaVersion !== undefined) {
        assertRestoreCompatibility({ appVersion: metadata.appVersion, schemaVersion: metadata.schemaVersion });
      }
      await assertRestoreDiskSpace(extracted, manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0));
      await rewriteRestoredMediaPaths(databasePath, metadata.mediaRoot);
      await validateRestoredMediaReferences(databasePath, extracted);

      heartbeat.assertOwned();
      updateRestoreStatus(id, 'maintenance', owner);
      // Keep a recovery copy using the same passphrase so the operator can
      // download it if the restored instance needs to be rolled back.
      const recovery = await createBackup(passphrase, String(row.requested_by), { maintenanceOwner: owner });
      recoveryBackup = recovery;
      recoveryBackupId = recovery.id;
      // Put the restore row, recovery-backup row and the same owner marker in
      // the staged database before its pathname is published.  If the process
      // dies immediately after the atomic rename, the replacement database is
      // therefore self-describing and can be resumed without the old
      // ensureRestoreRowAfterSwitch() window.
      prepareRestoredDatabaseForSwitch(databasePath, row, id, recovery, recoveryBackupId, owner);
      const switchContext: RestoreSwitchContext = {
        restoreId: id,
        owner,
        stagingPath: staging,
        inputPath: retainedInputPath,
        recoveryBackupId,
      };
      heartbeat.assertOwned();
      await waitForWriteLeases({ maintenanceOwner: owner });
      heartbeat.assertOwned();
      switchAttempted = true;
      switchInfo = await switchDatabase(databasePath, switchContext);
      switchJournal = await readRestoreSwitchJournal(switchInfo.journalPath, id);
      resetPipelineRuntime();
    }
    if (!extracted || !databasePath) throw new RestoreManualRecoveryError('恢复 staging 状态缺失，必须人工恢复');
    // Re-check the pre-written marker through the newly opened connection.
    // Keep `maintenanceAcquired` from the old DB so final cleanup clears the
    // marker in the replacement DB as well.
    beginMaintenance(owner, `restore:${id}`);
    heartbeat.assertOwned();
    ensureRestoreRowAfterSwitch(row, id, recoveryBackupId, owner);
    if (recoveryBackup) ensureBackupRowAfterSwitch(recoveryBackup, owner);
    if (!switchJournal || !switchInfo) throw new RestoreManualRecoveryError('恢复切换 journal 缺失，必须人工恢复');
    mediaJournal = switchJournal.mediaMutations.map((mutation) => ({ ...mutation }));
    const persistMediaJournal: PersistMediaJournal = async (journal) => {
      switchJournal = { ...switchJournal!, mediaMutations: journal.map((mutation) => ({ ...mutation })), updatedAt: now() };
      await writeRestoreSwitchJournal(switchJournal, switchInfo!.journalPath);
    };
    if (mediaJournal.length) {
      // A prior process may have died during media copy.  Roll back the
      // durable mutation journal first, then replay the source tree from
      // scratch under the same sidecar.  If rollback cannot be proven, the
      // outer catch keeps maintenance/manual recovery latched.
      await rollbackMediaRestore(mediaJournal);
      mediaJournal = [];
      await persistMediaJournal(mediaJournal);
    }
    mediaJournal = await restoreMedia(extracted, mediaJournal, persistMediaJournal, heartbeat.assertOwned);
    heartbeat.assertOwned();
    const completed = now();
    // This transaction is the logical restore commit. Cleanup of old media is
    // post-commit garbage collection and must never re-enter the rollback path
    // after even one old-generation file has been deleted.
    withMaintenanceTransaction(owner, (db) => {
      db.prepare('DELETE FROM sessions').run();
      db.prepare('UPDATE restore_jobs SET status = \'completed\', recovery_backup_id = ?, updated_at = ?, completed_at = ?, passphrase_ciphertext = \'\', error_message = NULL WHERE id = ?').run(recoveryBackupId, completed, completed, id);
    });
    terminal = true;
    mediaJournal = await commitMediaRestore(mediaJournal, persistMediaJournal);
    if (mediaJournal.length) {
      // Keep the owner fence and journal. A later worker poll retries only the
      // idempotent GC; the committed database/media generation stays live.
      releaseMaintenance = false;
      return getRestore(id)!;
    }
    await persistMediaJournal(mediaJournal);
    await removeRestoreSwitchJournal(switchInfo.journalPath, id);
    await cleanupDatabaseRollback(switchInfo);
    return getRestore(id)!;
    } finally {
      heartbeat.stop();
    }
  } catch (error) {
    // Once the replacement row is committed as completed, failures belong to
    // post-commit cleanup only.  Preserve the new database/media generation
    // and its journal; never route these failures through rollback.
    if (terminal) {
      releaseMaintenance = false;
      resetPipelineRuntime();
      throw error;
    }
    if (isMaintenanceError(error)) throw error;
    if (error instanceof RestoreManualRecoveryError && !(error instanceof DatabaseSwitchError)) {
      releaseMaintenance = false;
      try {
        const state = getMaintenanceState();
        if (state.active && state.owner === owner && !state.manualRecoveryRequired) {
          markMaintenanceManualRecovery(owner, error.message);
        }
      } catch { /* retain any existing fence/sidecar when SQLite is unavailable */ }
      resetPipelineRuntime();
      throw error;
    }
    const message = error instanceof Error ? error.message.slice(0, 1000) : '恢复失败';
    let rollbackFailure: unknown;
    let databaseRollbackHandled = false;
    if (error instanceof DatabaseSwitchError) {
      switchInfo = error.switchInfo;
      switchRolledBack = error.rollbackComplete;
      databaseRollbackHandled = true;
      // A failed pathname switch that could not be compensated is an
      // unrecoverable generation split.  Keep both the sidecar and the
      // maintenance fence for an operator; never mark the row terminal.
      if (!error.rollbackComplete) {
        releaseMaintenance = false;
        resetPipelineRuntime();
        rollbackFailure = error;
      }
    } else if (switchAttempted && !switchInfo) {
      // The switch helper wraps all expected move failures.  Reaching this
      // branch means the database generation is unknown (for example a
      // process-level I/O failure while closing SQLite), so fail closed.
      releaseMaintenance = false;
      resetPipelineRuntime();
      rollbackFailure = new RestoreManualRecoveryError('数据库切换状态未知，必须人工恢复', { cause: error });
    }
    if (mediaJournal) {
      try {
        await rollbackMediaRestore(mediaJournal);
        mediaJournal = [];
        if (switchJournal && switchInfo) {
          switchJournal = { ...switchJournal, mediaMutations: [], updatedAt: now() };
          await writeRestoreSwitchJournal(switchJournal, switchInfo.journalPath);
        }
      } catch (rollbackError) {
        rollbackFailure = combineRollbackFailures(rollbackFailure, rollbackError);
      }
    }
    if (switchInfo && !switchRolledBack && !databaseRollbackHandled) {
      try {
        await rollbackDatabaseSwitch(switchInfo);
        switchRolledBack = true;
      } catch (rollbackError) {
        // Both the old and staged databases carry the maintenance marker. If
        // rollback cannot be proven complete, keep that marker and the input
        // envelope for an operator instead of reopening writes on an unknown
        // database generation.
        releaseMaintenance = false;
        resetPipelineRuntime();
        rollbackFailure = combineRollbackFailures(rollbackFailure, rollbackError);
      }
    }
    if (rollbackFailure) {
      releaseMaintenance = false;
      resetPipelineRuntime();
      const rollbackMessage = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      // Preserve compensation details for diagnostics instead of exposing
      // only the original restore error as the Error.cause.
      const rollbackCause = rollbackFailure;
      if (error instanceof Error && rollbackCause && !('cause' in error)) {
        Object.defineProperty(error, 'cause', { value: rollbackCause, enumerable: false, configurable: true });
      }
      try {
        const state = getMaintenanceState();
        if (state.active && state.owner === owner && !state.manualRecoveryRequired) {
          markMaintenanceManualRecovery(owner, `恢复失败且自动回滚未完成：${rollbackMessage}`);
        }
      } catch { /* the sidecar remains the external fail-closed marker */ }
      throw new Error(`恢复失败且自动回滚未完成：${rollbackMessage}`, { cause: error });
    }
    if (switchAttempted || switchInfo) resetPipelineRuntime();
    try {
      ensureRestoreRowAfterSwitch(row, id, recoveryBackupId, owner);
      if (recoveryBackup) ensureBackupRowAfterSwitch(recoveryBackup, owner);
      withMaintenanceTransaction(owner, (db) => db.prepare('UPDATE restore_jobs SET status = \'failed\', recovery_backup_id = ?, error_message = ?, updated_at = ?, passphrase_ciphertext = \'\' WHERE id = ?').run(recoveryBackupId, message, now(), id));
      terminal = true;
    } catch { /* db may be unavailable during rollback; retain input for recovery */ }
    throw error;
  } finally {
    if (staging && releaseMaintenance && (terminal || !switchAttempted || switchRolledBack)) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!terminal) {
      try {
        const current = getRestore(id);
        terminal = current?.status === 'completed' || current?.status === 'failed';
      } catch { /* preserve the retained input when the DB is unavailable */ }
    }
    if (terminal) await removeManagedRestoreInput(retainedInputPath);
    if (releaseMaintenance) endMaintenance(owner, maintenanceAcquired);
  }
}

/** The portable snapshot intentionally omits restore_jobs.  Recreate the
 * active row after a database switch so status/error updates remain durable. */
function ensureRestoreRowAfterSwitch(row: Record<string, unknown>, id: string, recoveryBackupId: string | null, owner: string): void {
  withMaintenanceTransaction(owner, (transactionDb) => upsertActiveRestoreRow(transactionDb, row, id, recoveryBackupId));
}

function upsertActiveRestoreRow(db: Database.Database, row: Record<string, unknown>, id: string, recoveryBackupId: string | null): void {
  const createdAt = String(row.created_at || now());
  const updatedAt = now();
  db.prepare(`INSERT OR IGNORE INTO restore_jobs
    (id, status, requested_by, input_path, passphrase_ciphertext, recovery_backup_id, error_message, created_at, updated_at, completed_at)
    VALUES (?, 'maintenance', ?, ?, ?, ?, NULL, ?, ?, NULL)`)
    .run(id, resolveRestoredActor(db, String(row.requested_by)), String(row.input_path), String(row.passphrase_ciphertext || ''), recoveryBackupId, createdAt, updatedAt);
  db.prepare(`UPDATE restore_jobs SET status = 'maintenance', recovery_backup_id = ?, updated_at = ? WHERE id = ?`)
    .run(recoveryBackupId, updatedAt, id);
}

/** Recovery backup metadata was written to the pre-restore database.  Carry
 * the row into the restored database so its durable download reference stays
 * valid after the switch. */
function ensureBackupRowAfterSwitch(record: BackupRecord, owner: string): void {
  withMaintenanceTransaction(owner, (db) => upsertBackupRow(db, record));
}

function upsertBackupRow(db: Database.Database, record: BackupRecord): void {
  const outputPath = record.outputPath ? path.join(backupRoot(), path.basename(record.outputPath)) : null;
  db.prepare(`INSERT OR IGNORE INTO backup_jobs
    (id, status, requested_by, manifest_json, output_path, bytes, sha256, error_message, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.id,
      record.status,
      resolveRestoredActor(db, record.requestedBy),
      record.manifest ? JSON.stringify(record.manifest) : null,
      outputPath,
      record.bytes,
      record.sha256,
      record.errorMessage,
      record.createdAt,
      record.updatedAt,
      record.completedAt,
    );
}

/** Make the replacement database independently recoverable before publishing
 * its pathname.  All rows and the maintenance marker are committed in one
 * SQLite transaction and checkpointed before switchDatabase() proceeds. */
function prepareRestoredDatabaseForSwitch(
  databasePath: string,
  restoreRow: Record<string, unknown>,
  restoreId: string,
  recoveryBackup: BackupRecord,
  recoveryBackupId: string | null,
  owner: string,
): void {
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.transaction(() => {
      upsertActiveRestoreRow(database, restoreRow, restoreId, recoveryBackupId);
      upsertBackupRow(database, recoveryBackup);
      persistMaintenanceMarker(database, owner, `restore:${restoreId}`);
    })();
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
}

async function snapshotSources(staging: string): Promise<ArchiveSource[]> {
  const databasePath = path.join(staging, 'database', 'app.sqlite');
  await fsp.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const live = getDb();
  const liveName = String((live as unknown as { name?: string }).name || process.env.DATABASE_PATH || '');
  if (!liveName || liveName === ':memory:') throw new Error('内存数据库不能生成完整备份');
  await live.backup(databasePath);
  const snapshot = new Database(databasePath);
  try {
    snapshot.pragma('journal_mode = DELETE');
    snapshot.prepare('DELETE FROM sessions').run();
    snapshot.prepare('DELETE FROM backup_secrets').run();
    snapshot.prepare('DELETE FROM restore_jobs').run();
    // The maintenance marker belongs to the live process, never to a
    // portable snapshot.  A restored database must start writable and let the
    // restore operation establish a fresh owner marker after the switch.
    snapshot.prepare('DELETE FROM app_settings WHERE key = ?').run(MAINTENANCE_SETTING_KEY);
    snapshot.pragma('wal_checkpoint(TRUNCATE)');
  } finally { snapshot.close(); }

  const metadataPath = path.join(staging, 'metadata', 'system.json');
  await fsp.mkdir(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
  const metadata = {
    appVersion: readAppVersion(),
    schemaVersion: latestSchemaVersion(),
    createdAt: now(),
    nodeVersion: process.version,
    mediaRoot: mediaRoot(),
    // Provider keys and passwords are intentionally absent.
    secretPolicy: 'environment keys are excluded; database secrets remain encrypted by APP_MASTER_KEY',
  };
  await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  const sources: ArchiveSource[] = [
    { path: 'database/app.sqlite', sourcePath: databasePath, kind: 'database' },
    { path: 'metadata/system.json', sourcePath: metadataPath, kind: 'metadata' },
  ];
  const media = mediaRoot();
  const seen = new Set<string>();
  const addMediaSource = (asset: { path?: string; derivativeKind?: string }): void => {
    if (!asset.path) return;
    const absolute = path.resolve(asset.path);
    const prefix = media.endsWith(path.sep) ? media : `${media}${path.sep}`;
    if (!absolute.startsWith(prefix)) throw new Error('媒体资产路径位于媒体根目录之外');
    const relative = path.relative(media, absolute).split(path.sep).join('/');
    if (seen.has(relative)) return;
    seen.add(relative);
    sources.push({ path: `media/${relative}`, sourcePath: absolute, kind: asset.derivativeKind ? 'derivative' : 'original' });
  };
  const stateRow = live.prepare('SELECT state_json FROM pipeline_state WHERE id = 1').get() as { state_json?: string } | undefined;
  if (stateRow?.state_json) {
    try {
      const state = JSON.parse(stateRow.state_json) as { assets?: Record<string, { path?: string; derivativeKind?: string }> };
      for (const asset of Object.values(state.assets || {})) {
        addMediaSource(asset);
      }
    } catch (error) {
      throw new Error(`无法读取媒体资产清单：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Keep the normalized asset projection covered even when a deployment has
  // compacted/removed the legacy pipeline_state snapshot.
  const hasNormalized = live.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='pipeline_assets'").get() as { count: number };
  if (Number(hasNormalized.count)) {
    const rows = live.prepare('SELECT path, derivative_kind AS derivativeKind FROM pipeline_assets').all() as Array<{ path?: string; derivativeKind?: string }>;
    for (const asset of rows) addMediaSource(asset);
  }
  return sources;
}

async function validateRestoredDatabase(databasePath: string): Promise<void> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('恢复数据库 integrity_check 未通过');
    const foreign = database.pragma('foreign_key_check') as unknown[];
    if (foreign.length) throw new Error('恢复数据库外键检查未通过');
    const sessions = database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
    if (Number(sessions.count) !== 0) throw new Error('恢复包不能包含活动会话');
  } finally { database.close(); }
}

function persistMaintenanceMarker(database: Database.Database, owner: string, reason: string): void {
  const timestamp = now();
  // Keep the lease fields in the portable marker as well.  A restored
  // database must remain fenced until a worker explicitly resumes/finishes
  // the same restore operation; omitting the lease would make a stale marker
  // indistinguishable from a manually requested maintenance window.
  const state = JSON.stringify({
    active: true,
    owner,
    reason,
    changedAt: timestamp,
    leaseExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  database.prepare(`INSERT INTO app_settings (key, value, is_encrypted, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_encrypted = 0, updated_at = excluded.updated_at`)
    .run(MAINTENANCE_SETTING_KEY, state, timestamp);
}

async function validateRestoredMediaReferences(databasePath: string, extractedRoot: string): Promise<void> {
  const database = new Database(databasePath, { readonly: true });
  const referenced = new Map<string, { sha256?: string; bytes?: number }>();
  try {
    const stateRow = database.prepare('SELECT state_json FROM pipeline_state WHERE id = 1').get() as { state_json?: string } | undefined;
    if (stateRow?.state_json) {
      const state = JSON.parse(stateRow.state_json) as { assets?: Record<string, { path?: string; sha256?: string; bytes?: number }> };
      for (const asset of Object.values(state.assets || {})) {
        if (asset.path) referenced.set(asset.path, { sha256: asset.sha256, bytes: asset.bytes });
      }
    }
    const hasNormalized = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='pipeline_assets'").get() as { count: number };
    if (Number(hasNormalized.count)) {
      const rows = database.prepare('SELECT path, sha256, bytes FROM pipeline_assets').all() as Array<{ path: string; sha256?: string; bytes?: number }>;
      for (const asset of rows) referenced.set(asset.path, { sha256: asset.sha256, bytes: asset.bytes });
    }
  } finally { database.close(); }

  const root = mediaRoot();
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  for (const [assetPath, expected] of referenced) {
    const absolute = path.resolve(assetPath);
    if (!absolute.startsWith(prefix)) throw new Error('恢复数据库包含媒体根目录之外的引用');
    const relative = path.relative(root, absolute);
    const source = path.resolve(extractedRoot, 'media', relative);
    const sourcePrefix = `${path.resolve(extractedRoot, 'media')}${path.sep}`;
    if (!source.startsWith(sourcePrefix)) throw new Error('恢复媒体引用路径无效');
    const stat = await fsp.lstat(source).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`恢复包缺少媒体资产：${relative}`);
    if (expected.bytes !== undefined && stat.size !== expected.bytes) throw new Error(`恢复媒体大小不匹配：${relative}`);
    if (expected.sha256 && await hashFile(source) !== expected.sha256) throw new Error(`恢复媒体哈希不匹配：${relative}`);
  }
}

function resolveRestoredActor(db: Database.Database, requestedBy: string): string {
  const exact = db.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').get(requestedBy) as { id?: string } | undefined;
  if (exact?.id) return exact.id;
  const fallback = db.prepare("SELECT id FROM users ORDER BY CASE WHEN role = 'admin' AND is_active = 1 THEN 0 WHEN is_active = 1 THEN 1 ELSE 2 END, created_at ASC LIMIT 1").get() as { id?: string } | undefined;
  if (!fallback?.id) throw new Error('恢复数据库没有可用于记录恢复审计的账号');
  return fallback.id;
}

interface DatabaseSwitch {
  livePath: string;
  rollbackPath: string;
  journalPath: string;
}

interface RestoreSwitchContext {
  restoreId: string;
  owner: string;
  stagingPath: string;
  inputPath: string;
  recoveryBackupId: string | null;
}

async function switchDatabase(restoredPath: string, context?: RestoreSwitchContext): Promise<DatabaseSwitch> {
  const current = getDb();
  const livePath = String((current as unknown as { name?: string }).name || process.env.DATABASE_PATH || '');
  if (!livePath || livePath === ':memory:' || livePath.startsWith('file:')) throw new Error('当前数据库路径不支持原子恢复');
  const resolved = path.resolve(livePath);
  const rollbackPath = `${resolved}.pre-restore-${Date.now()}`;
  const journalPath = `${resolved}.restore-journal.json`;
  const info: DatabaseSwitch = { livePath: resolved, rollbackPath, journalPath };
  let stagedPath: string | undefined;
  let journalWritten = false;
  let liveMoved = false;
  let restoredMoved = false;
  try {
    await assertRegularFile(restoredPath, '待恢复数据库');
    await assertRegularFile(resolved, '当前数据库');
    // BACKUP_OUT_DIR is intentionally a separate named volume in Compose.
    // Copy the validated archive database beside the live inode first; only
    // this same-volume path is ever passed to rename(), so EXDEV cannot occur
    // after the old live database has been moved to rollback storage.
    const liveDirectory = path.dirname(resolved);
    await fsp.mkdir(liveDirectory, { recursive: true, mode: 0o700 });
    const liveBase = path.basename(resolved);
    const restoreToken = (context?.restoreId || 'internal').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    stagedPath = path.join(liveDirectory, `.${liveBase}.restore-${restoreToken}-${randomUUID()}.staged`);
    await fsp.copyFile(restoredPath, stagedPath, fs.constants.COPYFILE_EXCL);
    const stagedHandle = await fsp.open(stagedPath, 'r+');
    try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }
    await fsp.chmod(stagedPath, 0o600).catch(() => undefined);
    await syncDirectory(liveDirectory);
    await assertRegularFile(stagedPath, '同卷恢复 staging 数据库');
    if (context) {
      await writeRestoreSwitchJournal({
        version: 1,
        restoreId: context.restoreId,
        owner: context.owner,
        phase: 'switching',
        livePath: resolved,
        restoredPath: path.resolve(stagedPath),
        rollbackPath,
        stagingPath: path.resolve(context.stagingPath),
        inputPath: path.resolve(context.inputPath),
        recoveryBackupId: context.recoveryBackupId,
        mediaMutations: [],
        createdAt: now(),
        updatedAt: now(),
      }, journalPath);
      journalWritten = true;
    }
    await current.pragma('wal_checkpoint(TRUNCATE)');
    closeDb();
  } catch (error) {
    // No pathname has moved yet.  Do not manufacture a switch sidecar when
    // setup failed; the caller can safely persist a terminal validation error.
    if (stagedPath && !journalWritten) await fsp.rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  }
  if (!stagedPath) throw new RestoreManualRecoveryError('同卷恢复 staging 缺失，必须人工恢复');
  const publishPath = stagedPath;
  try {
    await fsp.rename(resolved, rollbackPath);
    liveMoved = true;
    await moveIfExists(`${resolved}-wal`, `${rollbackPath}-wal`);
    await moveIfExists(`${resolved}-shm`, `${rollbackPath}-shm`);
    await fsp.rename(publishPath, resolved);
    restoredMoved = true;
    if (context) {
      const journal = await readRestoreSwitchJournal(journalPath, context.restoreId);
      await writeRestoreSwitchJournal({ ...journal, phase: 'switched', updatedAt: now() }, journalPath);
    }
  } catch (error) {
    const compensationErrors: unknown[] = [];
    const compensate = async (action: string, operation: () => Promise<unknown>): Promise<void> => {
      try { await operation(); } catch (rollbackError) {
        compensationErrors.push(new Error(`${action}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: rollbackError }));
      }
    };
    if (restoredMoved) await compensate('撤回已发布的恢复数据库', () => moveIfExists(resolved, publishPath));
    if (liveMoved) {
      await compensate('恢复原数据库文件', () => moveIfExists(rollbackPath, resolved));
      await compensate('恢复原数据库 WAL', () => moveIfExists(`${rollbackPath}-wal`, `${resolved}-wal`));
      await compensate('恢复原数据库 SHM', () => moveIfExists(`${rollbackPath}-shm`, `${resolved}-shm`));
    }
    const [liveAfterCompensation, rollbackAfterCompensation, restoredAfterCompensation] = await Promise.all([
      fsp.lstat(resolved).catch(() => undefined),
      fsp.lstat(rollbackPath).catch(() => undefined),
      fsp.lstat(publishPath).catch(() => undefined),
    ]);
    const compensationProven = Boolean(
      liveAfterCompensation?.isFile() && !liveAfterCompensation.isSymbolicLink()
      && !rollbackAfterCompensation
      && restoredAfterCompensation?.isFile() && !restoredAfterCompensation.isSymbolicLink(),
    );
    if (!compensationProven) compensationErrors.push(new Error('database switch compensation pathname state is uncertain'));
    if (compensationErrors.length) {
      if (context) await updateRestoreSwitchJournalPhase(journalPath, context.restoreId, 'rollback_failed').catch(() => undefined);
      throw new DatabaseSwitchError('数据库切换失败且自动回滚未完成', info, false, {
        cause: new AggregateError(compensationErrors, '数据库切换补偿失败'),
      });
    }
    if (context) {
      try {
        await removeRestoreSwitchJournal(journalPath, context.restoreId);
      } catch (journalError) {
        throw new DatabaseSwitchError('数据库已安全回滚但恢复 journal 无法删除，必须人工确认', info, false, { cause: journalError });
      }
    }
    await fsp.rm(publishPath, { force: true }).catch(() => undefined);
    throw new DatabaseSwitchError('数据库切换失败，原数据库已安全保留', info, true, { cause: error });
  }
  return info;
}

/** Restore the pre-switch database after a post-switch validation/media
 * failure.  The restored file is removed only after the rollback connection
 * has been closed, and WAL/SHM sidecars are moved together with the database.
 */
async function rollbackDatabaseSwitch(info: DatabaseSwitch): Promise<void> {
  closeDb();
  const rollbackStat = await fsp.lstat(info.rollbackPath).catch(() => undefined);
  if (!rollbackStat?.isFile() || rollbackStat.isSymbolicLink()) throw new Error('恢复回滚数据库留底不存在或不是普通文件');
  const failedPath = `${info.livePath}.failed-restore-${Date.now()}-${randomUUID()}`;
  let currentMoved = false;
  let rollbackMoved = false;
  const errors: unknown[] = [];
  const attempt = async (action: string, operation: () => Promise<unknown>): Promise<void> => {
    try { await operation(); } catch (error) {
      errors.push(new Error(`${action}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };
  try {
    currentMoved = await moveIfExists(info.livePath, failedPath);
    await moveIfExists(`${info.livePath}-wal`, `${failedPath}-wal`);
    await moveIfExists(`${info.livePath}-shm`, `${failedPath}-shm`);
    await fsp.rename(info.rollbackPath, info.livePath);
    rollbackMoved = true;
    await moveIfExists(`${info.rollbackPath}-wal`, `${info.livePath}-wal`);
    await moveIfExists(`${info.rollbackPath}-shm`, `${info.livePath}-shm`);
    // The failed restored database is quarantined rather than deleted. A
    // later maintenance cleanup can remove it after the operator has checked
    // the error; keeping it here makes rollback failure recoverable.
  } catch (error) {
    // Best-effort restore of the original pathname. Any inability to complete
    // these moves is propagated to the caller, which keeps maintenance active.
    if (rollbackMoved) {
      await attempt('撤回回滚数据库文件', () => moveIfExists(info.livePath, info.rollbackPath));
      await attempt('撤回回滚数据库 WAL', () => moveIfExists(`${info.livePath}-wal`, `${info.rollbackPath}-wal`));
      await attempt('撤回回滚数据库 SHM', () => moveIfExists(`${info.livePath}-shm`, `${info.rollbackPath}-shm`));
    }
    if (currentMoved) {
      await attempt('恢复失败数据库文件原路径', () => moveIfExists(failedPath, info.livePath));
      await attempt('恢复失败数据库 WAL 原路径', () => moveIfExists(`${failedPath}-wal`, `${info.livePath}-wal`));
      await attempt('恢复失败数据库 SHM 原路径', () => moveIfExists(`${failedPath}-shm`, `${info.livePath}-shm`));
    }
    const [liveAfterFailure, rollbackAfterFailure] = await Promise.all([
      fsp.lstat(info.livePath).catch(() => undefined),
      fsp.lstat(info.rollbackPath).catch(() => undefined),
    ]);
    if (!liveAfterFailure?.isFile() || liveAfterFailure.isSymbolicLink() || rollbackAfterFailure) {
      errors.push(new Error('database rollback pathname state is not provably restored'));
    }
    if (errors.length) {
      try {
        await updateRestoreSwitchJournalPhase(info.journalPath, undefined, 'rollback_failed');
      } catch (journalError) {
        errors.push(new Error(`rollback journal update failed: ${journalError instanceof Error ? journalError.message : String(journalError)}`, { cause: journalError }));
      }
      throw new DatabaseSwitchError('数据库回滚失败且当前实例状态未知', info, false, {
        cause: new AggregateError([error, ...errors], '数据库回滚补偿失败'),
      });
    }
    throw new DatabaseSwitchError('数据库回滚失败，原数据库路径已恢复', info, true, { cause: error });
  }
  // Verify the pathname generation before declaring compensation complete.
  // If both generations remain (or the live file is absent), reopening writes
  // is unsafe and the maintenance fence must stay latched.
  const [liveAfter, rollbackAfter] = await Promise.all([
    fsp.lstat(info.livePath).catch(() => undefined),
    fsp.lstat(info.rollbackPath).catch(() => undefined),
  ]);
  if (!liveAfter?.isFile() || liveAfter.isSymbolicLink() || rollbackAfter) {
    await updateRestoreSwitchJournalPhase(info.journalPath, undefined, 'rollback_failed').catch(() => undefined);
    throw new DatabaseSwitchError('database rollback state could not be proven; manual recovery required', info, false);
  }
  // A successful rollback is a terminally safe outcome.  Remove the sidecar
  // only after all database and sidecar moves completed.
  try {
    await removeRestoreSwitchJournal(info.journalPath);
  } catch (journalError) {
    throw new DatabaseSwitchError('数据库已回滚但恢复 journal 无法删除，必须人工确认', info, false, { cause: journalError });
  }
}

async function moveIfExists(source: string, target: string): Promise<boolean> {
  try {
    await fsp.rename(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupDatabaseRollback(info: DatabaseSwitch | null): Promise<void> {
  if (!info) return;
  await fsp.rm(info.rollbackPath, { force: true }).catch(() => undefined);
  await fsp.rm(`${info.rollbackPath}-wal`, { force: true }).catch(() => undefined);
  await fsp.rm(`${info.rollbackPath}-shm`, { force: true }).catch(() => undefined);
}

async function rewriteRestoredMediaPaths(databasePath: string, oldRoot?: string): Promise<void> {
  if (!oldRoot) return;
  const previous = path.resolve(oldRoot);
  const current = mediaRoot();
  if (previous === current) return;
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      const stateRow = database.prepare('SELECT state_json FROM pipeline_state WHERE id = 1').get() as { state_json?: string } | undefined;
      if (stateRow?.state_json) {
        const state = JSON.parse(stateRow.state_json) as {
          assets?: Record<string, { path?: string }>;
          uploads?: Record<string, { originalPath?: string; chunkDir?: string }>;
        };
        for (const asset of Object.values(state.assets || {})) if (asset.path) asset.path = remapPath(asset.path, previous, current);
        for (const upload of Object.values(state.uploads || {})) {
          if (upload.originalPath) upload.originalPath = remapPath(upload.originalPath, previous, current);
          if (upload.chunkDir) upload.chunkDir = remapPath(upload.chunkDir, previous, current);
        }
        database.prepare('UPDATE pipeline_state SET state_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1').run(JSON.stringify(state), now());
      }
      const hasNormalized = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='pipeline_assets'").get() as { count: number };
      if (Number(hasNormalized.count)) {
        const assets = database.prepare('SELECT id, path FROM pipeline_assets').all() as Array<{ id: string; path: string }>;
        const update = database.prepare('UPDATE pipeline_assets SET path = ? WHERE id = ?');
        for (const asset of assets) update.run(remapPath(asset.path, previous, current), asset.id);
      }
    })();
  } finally { database.close(); }
}

function remapPath(value: string, previous: string, current: string): string {
  const absolute = path.resolve(value);
  const prefix = previous.endsWith(path.sep) ? previous : `${previous}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error('恢复数据库包含媒体根目录之外的路径');
  return path.join(current, path.relative(previous, absolute));
}

interface MediaMutation {
  target: string;
  previous: string | null;
  temp: string;
  state: 'planned' | 'previous_moved' | 'installed';
}

type MediaRestoreJournal = MediaMutation[];
type PersistMediaJournal = (journal: MediaRestoreJournal) => Promise<void>;

async function restoreMedia(
  extractedRoot: string,
  journal: MediaRestoreJournal = [],
  persist?: PersistMediaJournal,
  assertOwned?: () => void,
): Promise<MediaRestoreJournal> {
  const sourceRoot = path.join(extractedRoot, 'media');
  if (!(await exists(sourceRoot))) return journal;
  const targetRoot = mediaRoot();
  await fsp.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(targetRoot, targetRoot);
  const sourceStat = await fsp.lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('恢复媒体根目录不是普通目录');
  // Do not roll back here.  The caller owns the journal and must be able to
  // combine media and database compensation failures before deciding whether
  // the maintenance fence may be released.
  await copyTree(sourceRoot, targetRoot, targetRoot, journal, persist, assertOwned);
  return journal;
}

async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  managedRoot: string,
  journal: MediaRestoreJournal,
  persist?: PersistMediaJournal,
  assertOwned?: () => void,
): Promise<void> {
  assertOwned?.();
  const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    assertOwned?.();
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      const sourceStat = await fsp.lstat(source);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('恢复媒体包含符号链接目录');
      const existing = await fsp.lstat(target).catch(() => undefined);
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('媒体目标目录不是受控普通目录');
      if (!existing) await fsp.mkdir(target, { mode: 0o700 });
      await assertSafeDirectory(managedRoot, target);
      await copyTree(source, target, managedRoot, journal, persist, assertOwned);
    } else if (entry.isFile()) {
      await assertSafeDirectory(managedRoot, path.dirname(target));
      const targetStat = await fsp.lstat(target).catch(() => undefined);
      if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) throw new Error('媒体目标不是受控普通文件');
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      assertOwned?.();
      await fsp.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
      const previous = `${target}.pre-restore-${Date.now()}-${randomUUID()}`;
      const hadTarget = Boolean(targetStat);
      const mutation: MediaMutation = { target, previous: hadTarget ? previous : null, temp, state: 'planned' };
      journal.push(mutation);
      if (persist) await persist(journal);
      try {
        assertOwned?.();
        if (hadTarget) {
          await fsp.rename(target, previous);
          mutation.state = 'previous_moved';
          if (persist) await persist(journal);
        }
        assertOwned?.();
        await fsp.rename(temp, target);
        mutation.state = 'installed';
        if (persist) await persist(journal);
        assertOwned?.();
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        if (hadTarget) {
          // If the replacement was installed before ownership was lost, move
          // it aside before restoring the original pathname.  Never let a
          // platform rename silently overwrite the only recoverable copy.
          const current = await fsp.lstat(target).catch(() => undefined);
          if (current?.isFile() && !current.isSymbolicLink()) await fsp.rm(target, { force: true }).catch(() => undefined);
          await fsp.rename(previous, target).catch(() => undefined);
        } else if (mutation.state === 'installed') {
          await fsp.rm(target, { force: true }).catch(() => undefined);
        }
        const index = journal.indexOf(mutation);
        if (index >= 0) journal.splice(index, 1);
        if (persist) await persist(journal).catch(() => undefined);
        throw error;
      }
    } else {
      throw new Error('恢复媒体包含非普通文件');
    }
  }
}

async function rollbackMediaRestore(journal: MediaRestoreJournal): Promise<void> {
  const failures: unknown[] = [];
  for (const mutation of [...journal].reverse()) {
    try { await assertSafeMediaMutation(mutation); }
    catch (error) {
      failures.push(error);
      continue;
    }
    // A planned mutation has not moved the old target yet.  Removing only
    // its temporary copy is safe; deleting target here could destroy the
    // original file after a crash between journal fsync and rename.
    if (mutation.state === 'planned') {
      try { await fsp.rm(mutation.temp, { force: true }); }
      catch (error) { failures.push(new Error(`删除未提交媒体临时文件失败：${mutation.temp}：${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
      continue;
    }
    try { await fsp.rm(mutation.temp, { force: true }); }
    catch (error) { failures.push(new Error(`删除恢复媒体临时文件失败：${mutation.temp}：${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    if (mutation.previous) {
      const previousStat = await fsp.lstat(mutation.previous).catch(() => undefined);
      // Preserve the installed replacement when the old generation cannot be
      // proven recoverable. Removing it here would lose both generations.
      if (!previousStat?.isFile() || previousStat.isSymbolicLink()) {
        failures.push(new Error(`原媒体留底缺失，已保留恢复媒体：${mutation.target}`));
        continue;
      }
      try {
        if (mutation.state === 'installed') await fsp.rm(mutation.target, { force: true });
        else if (await exists(mutation.target)) throw new Error('原媒体目标路径已被占用');
        await fsp.rename(mutation.previous, mutation.target);
      } catch (error) {
        failures.push(new Error(`还原原媒体失败：${mutation.target}：${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    } else if (mutation.state === 'installed') {
      try { await fsp.rm(mutation.target, { force: true }); }
      catch (error) { failures.push(new Error(`删除恢复媒体失败：${mutation.target}：${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
    }
  }
  if (failures.length) throw new AggregateError(failures, '媒体恢复回滚未完成');
}

/** Idempotent post-commit garbage collection. Failed entries remain in the
 * durable journal and are retried by recoverCompletedRestoreFence(); this
 * routine never throws into the pre-commit rollback path. */
async function commitMediaRestore(journal: MediaRestoreJournal | null, persist?: PersistMediaJournal): Promise<MediaRestoreJournal> {
  let remaining = (journal || []).map((mutation) => ({ ...mutation }));
  for (const mutation of [...remaining]) {
    try {
      await assertSafeMediaMutation(mutation);
      if (mutation.previous) await fsp.rm(mutation.previous, { force: true });
      await fsp.rm(mutation.temp, { force: true });
      const next = remaining.filter((entry) => entry.target !== mutation.target || entry.temp !== mutation.temp);
      if (persist) await persist(next);
      remaining = next;
    } catch {
      // Retain this mutation. Missing previous files are accepted by force rm
      // on the next pass; unsafe/symlink paths remain fenced for an operator.
    }
  }
  return remaining;
}

async function assertSafeDirectory(root: string, candidate: string): Promise<void> {
  const managed = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== managed && !resolved.startsWith(`${managed}${path.sep}`)) throw new Error('媒体路径越界');
  const relative = path.relative(managed, resolved);
  let current = managed;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await fsp.lstat(current).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('媒体目录包含符号链接或非目录节点');
  }
  const rootStat = await fsp.lstat(managed).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('媒体根目录不是受控普通目录');
}

async function assertSafeMediaMutation(mutation: MediaMutation): Promise<void> {
  const root = mediaRoot();
  const prefix = `${path.resolve(root)}${path.sep}`;
  for (const candidate of [mutation.target, mutation.temp, mutation.previous]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(prefix)) throw new Error('恢复媒体 journal 路径越界');
    await assertSafeDirectory(root, path.dirname(resolved));
    const stat = await fsp.lstat(resolved).catch(() => undefined);
    if (stat?.isSymbolicLink() || stat && !stat.isFile()) throw new Error('恢复媒体 journal 指向非普通文件');
  }
  if (mutation.state === 'installed') {
    const installed = await fsp.lstat(mutation.target).catch(() => undefined);
    if (!installed?.isFile() || installed.isSymbolicLink()) throw new Error('已提交恢复媒体缺失，拒绝删除原媒体留底');
  }
}

async function waitForPipelineLeases(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!getPipelineRuntime().store.hasActiveLeases()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('等待 Worker 租约结束超时');
}

function updateRestoreStatus(id: string, status: RestoreStatus, owner: string): void {
  withMaintenanceTransaction(owner, (db) => db.prepare('UPDATE restore_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id));
}
function readAppVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return packageJson.version || 'unknown';
  } catch { return 'unknown'; }
}
function latestSchemaVersion(): string {
  const row = getDb().prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as { version?: string } | undefined;
  return row?.version || 'unknown';
}

/** Reject archives produced by a newer/incompatible deployment before the
 * restored inode can be published. Older known schema revisions are allowed
 * because normal startup migrations can advance them after the switch. */
function assertRestoreCompatibility(value: Pick<BackupManifest, 'appVersion' | 'schemaVersion'>): void {
  const currentApp = readAppVersion();
  const incomingApp = String(value.appVersion || '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(currentApp) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(incomingApp)) {
    throw new Error('备份应用版本无法验证');
  }
  const currentMajor = Number(currentApp.split('.')[0]);
  const incomingMajor = Number(incomingApp.split('.')[0]);
  if (currentMajor !== incomingMajor) throw new Error('备份应用主版本与当前部署不兼容');

  const incomingSchema = String(value.schemaVersion || '');
  if (!/^\d+[_-][^/\\]{1,120}\.sql$/i.test(incomingSchema)) throw new Error('备份 schema 版本无法验证');
  const migrationRoot = path.join(process.cwd(), 'migrations');
  const known = fs.existsSync(migrationRoot)
    ? fs.readdirSync(migrationRoot).filter((file) => /^\d+[_-].+\.sql$/i.test(file)).sort((a, b) => a.localeCompare(b, 'en'))
    : [];
  if (!known.includes(incomingSchema)) throw new Error('备份 schema 版本不属于当前部署');
  const currentSchema = latestSchemaVersion();
  if (known.indexOf(incomingSchema) > known.indexOf(currentSchema)) throw new Error('备份 schema 版本高于当前部署');
}

/** Check free space after extraction and before copying media into the live
 * volume. `statfs` is available in supported Node 20+ runtimes; a missing or
 * malformed result fails closed in production rather than guessing. */
async function assertRestoreDiskSpace(extractedRoot: string, declaredBytes: number): Promise<void> {
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) throw new Error('备份展开大小无效');
  const statfs = (fsp as typeof fsp & { statfs?: (path: string, options?: { bigint?: boolean }) => Promise<{ bavail: bigint | number; bsize: bigint | number }> }).statfs;
  if (!statfs) {
    if (process.env.NODE_ENV === 'production') throw new Error('当前运行时不支持磁盘空间检查');
    return;
  }
  const target = mediaRoot();
  const [stagingFs, targetFs] = await Promise.all([statfs(extractedRoot, { bigint: true }), statfs(target, { bigint: true }).catch(() => statfs(path.dirname(target), { bigint: true }))]);
  const available = (value: { bavail: bigint | number; bsize: bigint | number }): bigint => BigInt(value.bavail) * BigInt(value.bsize);
  // Media is present in the staging archive and copied once more into the
  // live volume; reserve a conservative 2x payload plus 64 MiB metadata.
  const required = BigInt(declaredBytes) * 2n + 64n * 1024n * 1024n;
  if (available(stagingFs) < required || available(targetFs) < required) throw new Error('磁盘可用空间不足，恢复已安全停止');
}
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(filePath: string): Promise<boolean> {
  try { await fsp.lstat(filePath); return true; } catch { return false; }
}

async function removeManagedRestoreInput(filePath: string): Promise<void> {
  const root = `${path.resolve(path.join(backupRoot(), '.incoming'))}${path.sep}`;
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(root)) await fsp.rm(resolved, { force: true }).catch(() => undefined);
}

function combineRollbackFailures(previous: unknown, next: unknown): unknown {
  if (!previous) return next;
  return new AggregateError([previous, next], '多个恢复回滚步骤失败');
}

async function quarantineExistingBackupOutput(outputPath: string, backupId: string): Promise<string | null> {
  const stat = await fsp.lstat(outputPath).catch(() => undefined);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RestoreManualRecoveryError('已有备份输出不是普通文件，拒绝覆盖');
  const directory = path.dirname(outputPath);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const quarantined = path.join(directory, `.orphan-${backupId}-${randomUUID()}.jwbackup`);
    try {
      await fsp.rename(outputPath, quarantined);
      await syncDirectory(directory);
      return quarantined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      throw new RestoreManualRecoveryError('已有备份输出无法安全隔离，拒绝覆盖', { cause: error });
    }
  }
  throw new RestoreManualRecoveryError('备份输出隔离名称冲突，必须人工处理');
}

function restoreJournalPath(livePath: string): string {
  const resolved = path.resolve(livePath);
  if (!resolved || resolved === path.parse(resolved).root) throw new Error('恢复数据库路径无效');
  return `${resolved}.restore-journal.json`;
}

/** Validate only the non-secret fields needed by startup recovery. */
function isRestoreSwitchJournal(value: unknown): value is RestoreSwitchJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RestoreSwitchJournal>;
  return candidate.version === 1
    && typeof candidate.restoreId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(candidate.restoreId)
    && typeof candidate.owner === 'string' && candidate.owner.length > 0 && candidate.owner.length <= 512
    && (candidate.phase === 'switching' || candidate.phase === 'switched' || candidate.phase === 'rollback_failed')
    && typeof candidate.livePath === 'string' && path.isAbsolute(candidate.livePath)
    && typeof candidate.restoredPath === 'string' && path.isAbsolute(candidate.restoredPath)
    && typeof candidate.rollbackPath === 'string' && path.isAbsolute(candidate.rollbackPath)
    && typeof candidate.stagingPath === 'string' && path.isAbsolute(candidate.stagingPath)
    && typeof candidate.inputPath === 'string' && path.isAbsolute(candidate.inputPath)
    && (candidate.recoveryBackupId === null || typeof candidate.recoveryBackupId === 'string')
    && Array.isArray(candidate.mediaMutations)
    && candidate.mediaMutations.every((mutation) => {
      if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) return false;
      const item = mutation as Partial<RestoreSwitchJournal['mediaMutations'][number]>;
      return typeof item.target === 'string' && path.isAbsolute(item.target)
        && (item.previous === null || typeof item.previous === 'string' && path.isAbsolute(item.previous))
        && typeof item.temp === 'string' && path.isAbsolute(item.temp)
        && (item.state === 'planned' || item.state === 'previous_moved' || item.state === 'installed');
    })
    && typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string';
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fsp.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label}不存在或不是普通文件`);
}

/** Read and validate a sidecar without ever following a symlink. */
async function readRestoreSwitchJournal(journalPath: string, expectedRestoreId?: string): Promise<RestoreSwitchJournal> {
  const stat = await fsp.lstat(journalPath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new RestoreManualRecoveryError('恢复 journal 不存在或不是普通文件');
  let parsed: unknown;
  try { parsed = JSON.parse(await fsp.readFile(journalPath, 'utf8')); }
  catch (error) { throw new RestoreManualRecoveryError('恢复 journal 损坏，必须人工恢复', { cause: error }); }
  if (!isRestoreSwitchJournal(parsed)) throw new RestoreManualRecoveryError('恢复 journal 格式无效，必须人工恢复');
  const journal = parsed as RestoreSwitchJournal;
  if (restoreJournalPath(journal.livePath) !== path.resolve(journalPath)) {
    throw new RestoreManualRecoveryError('恢复 journal 与数据库路径不匹配，必须人工恢复');
  }
  if (expectedRestoreId && journal.restoreId !== expectedRestoreId) {
    throw new RestoreManualRecoveryError('恢复 journal 属于其他任务，必须人工恢复');
  }
  const live = path.resolve(journal.livePath);
  const liveDirectory = path.dirname(live);
  const liveBase = path.basename(live);
  const rollback = path.resolve(journal.rollbackPath);
  const restored = path.resolve(journal.restoredPath);
  if (path.dirname(rollback) !== liveDirectory || !path.basename(rollback).startsWith(`${liveBase}.pre-restore-`)) {
    throw new RestoreManualRecoveryError('恢复 journal 回滚路径不受管理');
  }
  if (path.dirname(restored) !== liveDirectory
    || !path.basename(restored).startsWith(`.${liveBase}.restore-`)
    || !path.basename(restored).endsWith('.staged')) {
    throw new RestoreManualRecoveryError('恢复 journal 同卷 staging 路径不受管理');
  }
  const managedBackupRoot = path.resolve(backupRoot());
  if (!path.resolve(journal.stagingPath).startsWith(`${managedBackupRoot}${path.sep}`)
    || !path.resolve(journal.inputPath).startsWith(`${path.join(managedBackupRoot, '.incoming')}${path.sep}`)) {
    throw new RestoreManualRecoveryError('恢复 journal 备份路径不受管理');
  }
  const media = path.resolve(mediaRoot());
  const mediaPrefix = `${media}${path.sep}`;
  for (const mutation of journal.mediaMutations) {
    for (const candidate of [mutation.target, mutation.temp, mutation.previous]) {
      if (candidate && !path.resolve(candidate).startsWith(mediaPrefix)) {
        throw new RestoreManualRecoveryError('恢复 journal 媒体路径越界，必须人工恢复');
      }
    }
  }
  return journal;
}

/** Write a journal record durably.  The first publication is exclusive and
 * never clobbers an unrelated operator file.  Updates for the same restore
 * id use an atomic rename where supported; Windows filesystems that reject a
 * replace fall back to an fsynced in-place update, which still fails closed if
 * interrupted (the parser rejects a torn record). */
async function writeRestoreSwitchJournal(journal: RestoreSwitchJournal, journalPath = restoreJournalPath(journal.livePath)): Promise<void> {
  const resolvedJournalPath = path.resolve(journalPath);
  if (restoreJournalPath(journal.livePath) !== resolvedJournalPath) throw new RestoreManualRecoveryError('恢复 journal 路径无效');
  await fsp.mkdir(path.dirname(resolvedJournalPath), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  const tempPath = `${resolvedJournalPath}.${process.pid}.${randomUUID()}.tmp`;
  const temp = await fsp.open(tempPath, 'wx', 0o600);
  try {
    await temp.write(bytes);
    await temp.sync();
  } finally { await temp.close(); }
  const existingStat = await fsp.lstat(resolvedJournalPath).catch(() => undefined);
  if (!existingStat) {
    let published = false;
    try {
      // A hard link publishes the already-fsynced inode atomically and cannot
      // overwrite an existing pathname.
      await fsp.link(tempPath, resolvedJournalPath);
      published = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') {
        await fsp.rm(tempPath, { force: true }).catch(() => undefined);
        if (code !== 'EEXIST') throw error;
      } else {
        // Named volumes/filesystems without hard-link support retain the same
        // no-clobber guarantee through an exclusive destination handle.
        try {
          const destination = await fsp.open(resolvedJournalPath, 'wx', 0o600);
          try {
            await destination.write(bytes);
            await destination.sync();
          } finally { await destination.close(); }
          published = true;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== 'EEXIST') {
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
            throw fallbackError;
          }
        }
      }
    }
    if (published) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      await syncDirectory(path.dirname(resolvedJournalPath));
      return;
    }
  }

  // Never replace an unrelated journal. Reading it also detects a torn or
  // malicious file before an in-place same-id phase update is attempted.
  const existing = await readRestoreSwitchJournal(resolvedJournalPath).catch((readError) => {
    throw new RestoreManualRecoveryError('已有恢复 journal 无法校验，必须人工恢复', { cause: readError });
  });
  if (existing.restoreId !== journal.restoreId) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw new RestoreManualRecoveryError('已有其他恢复任务 journal，拒绝覆盖');
  }
  try {
    const handle = await fsp.open(resolvedJournalPath, 'r+', 0o600);
    try {
      await handle.truncate(0);
      await handle.write(bytes, 0, bytes.length, 0);
      await handle.sync();
    } finally { await handle.close(); }
  } finally { await fsp.rm(tempPath, { force: true }).catch(() => undefined); }
  await syncDirectory(path.dirname(resolvedJournalPath));
}

async function updateRestoreSwitchJournalPhase(journalPath: string, expectedRestoreId: string | undefined, phase: RestoreSwitchJournal['phase']): Promise<void> {
  const journal = await readRestoreSwitchJournal(journalPath, expectedRestoreId);
  await writeRestoreSwitchJournal({ ...journal, phase, updatedAt: now() }, journalPath);
}

async function removeRestoreSwitchJournal(journalPath: string, expectedRestoreId?: string): Promise<void> {
  const existing = await fsp.lstat(journalPath).catch(() => undefined);
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink()) throw new RestoreManualRecoveryError('恢复 journal 不是普通文件，拒绝删除');
  if (expectedRestoreId) await readRestoreSwitchJournal(journalPath, expectedRestoreId);
  await fsp.rm(journalPath, { force: false });
  await syncDirectory(path.dirname(journalPath));
}

async function findRestoreSwitchJournalForCurrentDatabase(expectedRestoreId: string): Promise<RestoreSwitchJournal | null> {
  const current = getDb();
  const liveName = String((current as unknown as { name?: string }).name || process.env.DATABASE_PATH || '');
  if (!liveName || liveName === ':memory:' || liveName.startsWith('file:')) return null;
  const journalPath = restoreJournalPath(liveName);
  const stat = await fsp.lstat(journalPath).catch(() => undefined);
  if (!stat) return null;
  return readRestoreSwitchJournal(journalPath, expectedRestoreId);
}

/** Finish the tiny post-commit window after a worker crash.  The replacement
 * row is already `completed`; only the maintenance marker/sidecar cleanup is
 * pending.  Any uncertainty leaves the fence in place for an administrator. */
export async function recoverCompletedRestoreFence(expectedRestoreId?: string): Promise<void> {
  const state = getMaintenanceState();
  if (!state.active || state.manualRecoveryRequired || !state.owner) return;
  const match = /^restore:([^:]+):/.exec(state.owner);
  if (!match || (expectedRestoreId && match[1] !== expectedRestoreId)) return;
  const id = match[1];
  const row = getDb().prepare('SELECT status FROM restore_jobs WHERE id = ?').get(id) as { status?: string } | undefined;
  if (row?.status !== 'completed') return;
  const current = getDb();
  const liveName = String((current as unknown as { name?: string }).name || process.env.DATABASE_PATH || '');
  if (!liveName || liveName === ':memory:' || liveName.startsWith('file:')) {
    clearMaintenanceMode(state.owner);
    return;
  }
  const journalPath = restoreJournalPath(liveName);
  const journalStat = await fsp.lstat(journalPath).catch(() => undefined);
  if (journalStat) {
    const journal = await readRestoreSwitchJournal(journalPath, id);
    if (!(await journalHasPublishedReplacement(journal))) {
      throw new RestoreManualRecoveryError('已完成恢复 journal 与文件状态不一致，必须人工确认');
    }
    // Retry only post-commit media GC.  The replacement generation is already
    // authoritative; a failed unlink must never trigger rollback of its DB or
    // installed files.
    const remaining = await commitMediaRestore(journal.mediaMutations, async (next) => {
      await writeRestoreSwitchJournal({ ...journal, mediaMutations: next.map((mutation) => ({ ...mutation })), updatedAt: now() }, journalPath);
    });
    if (remaining.length) return;
    // Remove the journal before deleting the rollback inode.  A crash between
    // these operations leaves an extra quarantined file, not an apparently
    // interrupted database switch that blocks startup or risks split-brain.
    await removeRestoreSwitchJournal(journalPath, id);
    await cleanupDatabaseRollback({ livePath: journal.livePath, rollbackPath: journal.rollbackPath, journalPath });
  }
  clearMaintenanceMode(state.owner);
}

async function journalHasPublishedReplacement(journal: RestoreSwitchJournal): Promise<boolean> {
  const [live, rollback, restored] = await Promise.all([
    fsp.lstat(journal.livePath).catch(() => undefined),
    fsp.lstat(journal.rollbackPath).catch(() => undefined),
    fsp.lstat(journal.restoredPath).catch(() => undefined),
  ]);
  const isRegular = (stat: fs.Stats | undefined): boolean => Boolean(stat?.isFile() && !stat.isSymbolicLink());
  const liveFile = isRegular(live);
  const rollbackFile = isRegular(rollback);
  const restoredFile = isRegular(restored);
  if (journal.phase === 'switched') {
    if (!liveFile || !rollbackFile || restoredFile) throw new RestoreManualRecoveryError('恢复 journal 与文件状态不一致，必须人工恢复');
    return true;
  }
  if (journal.phase === 'switching') {
    if (liveFile && !rollbackFile && restoredFile) return false;
    if (liveFile && rollbackFile && !restoredFile) return true;
    // A missing live path with both rollback and staged files means the
    // process died between the two renames.  db.ts/startup recovery must
    // repair this explicitly; opening a new database here would be unsafe.
    throw new RestoreManualRecoveryError('恢复切库中断，数据库路径状态不完整，必须人工恢复');
  }
  throw new RestoreManualRecoveryError('恢复 journal 要求人工恢复');
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not permit opening a directory as a sync handle.  The
    // file itself is still fsynced; ignore only platform limitations.
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL') throw error;
  }
}

function parseLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
