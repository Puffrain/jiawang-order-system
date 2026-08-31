import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, type SqliteDatabase } from './db';
import { MAINTENANCE_SETTING_KEY, MaintenanceError } from './maintenance-types';

export { MAINTENANCE_SETTING_KEY, MaintenanceError } from './maintenance-types';

export interface MaintenanceState {
  active: boolean;
  owner: string | null;
  reason: string | null;
  changedAt: string | null;
  leaseExpiresAt: string | null;
  /** A failed/uncertain restore must be cleared by an administrator; it is
   * never reclaimed automatically after a lease timeout. */
  manualRecoveryRequired: boolean;
}

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_WRITE_LEASE_MS = 60 * 1000;
const DEFAULT_WRITE_LEASE_WAIT_MS = 30 * 1000;

export interface WriteLeaseRecord {
  id: string;
  owner: string;
  kind: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WriteLeaseOptions {
  owner?: string;
  ttlMs?: number;
  /** Enabled by default. Long-running operations should also call renew()
   * immediately before their final filesystem/database commit. */
  heartbeat?: boolean;
}

export interface WriteLeaseContext {
  readonly lease: WriteLeaseRecord;
  /** Renew the durable lease, throwing if another process has reclaimed it. */
  renew(ttlMs?: number): WriteLeaseRecord;
  /** Re-read the durable row and throw if it is missing or expired. */
  assertActive(): WriteLeaseRecord;
}

export interface WaitForWriteLeasesOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** When supplied, every poll verifies that this maintenance owner still
   * holds the marker. This closes the gap between draining and snapshotting. */
  maintenanceOwner?: string;
}

export class WriteLeaseError extends Error {
  readonly class = 'io' as const;
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: 'WRITE_LEASE_LOST' | 'WRITE_LEASE_TIMEOUT',
    readonly status: number,
    retryable = true
  ) {
    super(message);
    this.name = 'WriteLeaseError';
    this.retryable = retryable;
  }
}

function inactiveState(): MaintenanceState {
  return { active: false, owner: null, reason: null, changedAt: null, leaseExpiresAt: null, manualRecoveryRequired: false };
}

function parseState(value: unknown): MaintenanceState {
  // Absence means the installation has never entered maintenance. A present
  // but malformed marker is an uncertain recovery state and must fail closed;
  // treating corrupt JSON as inactive would let lease-based writers bypass
  // the stricter transaction fence in lib/db.ts.
  if (value === undefined || value === null) return inactiveState();
  if (typeof value !== 'string' || !value.trim()) {
    throw new MaintenanceError('维护状态损坏，系统已停止写入', 'MAINTENANCE', 503);
  }
  try {
    const parsed = JSON.parse(value) as Partial<MaintenanceState>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.active !== 'boolean') {
      throw new MaintenanceError('维护状态格式无效，系统已停止写入', 'MAINTENANCE', 503);
    }
    if (parsed.active === false) return inactiveState();
    if (typeof parsed.owner !== 'string' || !parsed.owner.trim()) {
      throw new MaintenanceError('维护状态缺少所有者，系统已停止写入', 'MAINTENANCE', 503);
    }
    return {
      active: true,
      owner: parsed.owner.trim().slice(0, 256),
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      changedAt: typeof parsed.changedAt === 'string' ? parsed.changedAt : null,
      leaseExpiresAt: typeof parsed.leaseExpiresAt === 'string' ? parsed.leaseExpiresAt : null,
      manualRecoveryRequired: parsed.manualRecoveryRequired === true
    };
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('维护状态无法解析，系统已停止写入', 'MAINTENANCE', 503);
  }
}

function readState(db: SqliteDatabase): MaintenanceState {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(MAINTENANCE_SETTING_KEY) as
    | { value?: string }
    | undefined;
  return parseState(row?.value);
}

function normalizeOwner(owner: string): string {
  const normalized = owner.trim().slice(0, 256);
  if (!normalized) throw new MaintenanceError('维护模式必须有所有者', 'MAINTENANCE_OWNER', 400);
  return normalized;
}

function maintenanceLeaseMs(): number {
  const value = Number(process.env.MAINTENANCE_LEASE_MS);
  return Number.isSafeInteger(value) && value >= 60_000 && value <= 24 * 60 * 60 * 1000 ? value : DEFAULT_LEASE_MS;
}

function writeLeaseMs(value?: number): number {
  const configured = value ?? Number(process.env.WRITE_LEASE_TTL_MS);
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 24 * 60 * 60 * 1000
    ? configured
    : DEFAULT_WRITE_LEASE_MS;
}

function writeLeaseWaitMs(value?: number): number {
  const configured = value ?? Number(process.env.WRITE_LEASE_WAIT_MS);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 24 * 60 * 60 * 1000
    ? configured
    : DEFAULT_WRITE_LEASE_WAIT_MS;
}

function makeState(owner: string, reason: string): MaintenanceState {
  const changedAt = new Date().toISOString();
  return {
    active: true,
    owner,
    reason: reason.trim().slice(0, 500) || '系统维护中',
    changedAt,
    leaseExpiresAt: new Date(Date.now() + maintenanceLeaseMs()).toISOString(),
    manualRecoveryRequired: false
  };
}

function isStaleWorkerState(state: MaintenanceState): boolean {
  if (state.manualRecoveryRequired) return false;
  if (!state.owner || !/^(?:backup|restore):/.test(state.owner)) return false;
  // A restore marker is a database-generation fence. It may only be resumed
  // by the same durable restore row/owner; another operation must never steal
  // it merely because a lease clock elapsed while a process was paused.
  if (state.owner.startsWith('restore:')) return false;
  // Do not reclaim a live worker's marker solely because its heartbeat was
  // delayed. Owners include a PID; an explicit liveness check closes the
  // window in which a second process could enter maintenance while the first
  // is still able to commit a snapshot.
  const pidMatch = /^(?:backup|restore):[^:]+:(\d+):/.exec(state.owner);
  if (pidMatch) {
    const pid = Number(pidMatch[1]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; } catch { /* process is gone */ }
    }
  }
  // A sidecar journal is an external recovery fence even if the SQLite marker
  // predates the journal write. Keep maintenance owned until the restore
  // worker/operator resolves it.
  if (restoreJournalPresent()) return false;
  const expiry = state.leaseExpiresAt ? Date.parse(state.leaseExpiresAt) : NaN;
  if (Number.isFinite(expiry)) return expiry <= Date.now();
  const changed = state.changedAt ? Date.parse(state.changedAt) : NaN;
  return Number.isFinite(changed) && Date.now() - changed >= maintenanceLeaseMs();
}

function restoreJournalPresent(): boolean {
  const configured = process.env.DATABASE_PATH?.trim();
  if (!configured || configured === ':memory:' || configured.startsWith('file:')) return false;
  try { return fs.existsSync(`${path.resolve(configured)}.restore-journal.json`); }
  catch { return true; }
}

function persistState(db: SqliteDatabase, state: MaintenanceState): void {
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_settings (key, value, is_encrypted, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_encrypted = 0, updated_at = excluded.updated_at`
  ).run(MAINTENANCE_SETTING_KEY, JSON.stringify(state), timestamp);
}

/** Use BEGIN IMMEDIATE for the maintenance/write-lease arbitration point.
 * A deferred read followed by a write can otherwise lose a WAL snapshot race
 * to a second process and surface SQLITE_BUSY instead of the typed gate. */
function withImmediateTransaction<T>(fn: (db: SqliteDatabase) => T): T {
  const db = getDb();
  return db.transaction(() => fn(db)).immediate();
}

export function getMaintenanceState(): MaintenanceState {
  return readState(getDb());
}

/** Atomically enter maintenance mode. The same owner may call this
 * idempotently; a different owner receives a conflict instead of stealing it. */
export function enterMaintenanceMode(owner: string, reason = '系统维护中'): MaintenanceState {
  const normalizedOwner = normalizeOwner(owner);
  return withImmediateTransaction((db) => {
    const current = readState(db);
    if (current.active) {
      if (current.owner === normalizedOwner) return current;
      // A crashed backup/restore worker may leave a marker behind. Reclaim it
      // only after its explicit lease expires; regular request owners are
      // never silently overridden.
      if (isStaleWorkerState(current)) {
        const state = makeState(normalizedOwner, reason);
        persistState(db, state);
        return state;
      }
      throw new MaintenanceError(current.reason || '系统维护中', 'MAINTENANCE_BUSY', 409);
    }
    const state = makeState(normalizedOwner, reason);
    persistState(db, state);
    return state;
  });
}

/** Clear maintenance only for its owner, unless an administrator explicitly
 * requests a force clear to recover from a crashed process. */
export function clearMaintenanceMode(owner: string, force = false): boolean {
  const normalizedOwner = normalizeOwner(owner);
  return withImmediateTransaction((db) => {
    const current = readState(db);
    if (!current.active) return false;
    if (!force && current.owner && current.owner !== normalizedOwner) {
      throw new MaintenanceError('维护模式由其他任务持有', 'MAINTENANCE_OWNER', 409);
    }
    const state: MaintenanceState = {
      active: false,
      owner: null,
      reason: null,
      changedAt: new Date().toISOString(),
      leaseExpiresAt: null,
      manualRecoveryRequired: false
    };
    persistState(db, state);
    return true;
  });
}

/** Extend the owner lease during long archive/restore operations. */
export function touchMaintenanceMode(owner: string, leaseMs = maintenanceLeaseMs()): boolean {
  const normalizedOwner = normalizeOwner(owner);
  return withImmediateTransaction((db) => {
    const current = readState(db);
    if (!current.active || current.owner !== normalizedOwner) return false;
    if (current.manualRecoveryRequired) return false;
    const changedAt = new Date().toISOString();
    persistState(db, { ...current, changedAt, leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() });
    return true;
  });
}

/** Fence an uncertain restore/rollback until an administrator explicitly
 * inspects the sidecar journal and force-clears maintenance. */
export function markMaintenanceManualRecovery(owner: string, reason: string): MaintenanceState {
  const normalizedOwner = normalizeOwner(owner);
  return withImmediateTransaction((db) => {
    const current = readState(db);
    if (!current.active || current.owner !== normalizedOwner) {
      throw new MaintenanceError('维护模式所有权已丢失，无法标记人工恢复', 'MAINTENANCE_OWNER', 409);
    }
    const state: MaintenanceState = {
      ...current,
      reason: reason.trim().slice(0, 500) || '需要人工恢复',
      changedAt: new Date().toISOString(),
      leaseExpiresAt: null,
      manualRecoveryRequired: true
    };
    persistState(db, state);
    return state;
  });
}

/** Backwards-compatible setter used by administrative callers. */
export function setMaintenanceMode(active: boolean, owner: string, reason = '系统维护中'): void {
  if (active) enterMaintenanceMode(owner, reason);
  else clearMaintenanceMode(owner);
}

export function assertNotInMaintenance(allowedOwner?: string): void {
  const state = getMaintenanceState();
  if (state.active && (!allowedOwner || state.owner !== allowedOwner)) {
    throw new MaintenanceError(state.reason || '系统维护中', 'MAINTENANCE', 503);
  }
}

/** Atomically register an in-flight write after checking the maintenance
 * marker. Expired rows are reclaimed in the same transaction, so a crashed
 * process cannot permanently block backup or restore. */
export function acquireWriteLease(kind: string, options: WriteLeaseOptions = {}): WriteLeaseRecord {
  const normalizedKind = normalizeWriteLeaseKind(kind);
  const owner = normalizeWriteLeaseOwner(options.owner || `${process.pid}:${randomUUID()}`);
  const ttlMs = writeLeaseMs(options.ttlMs);
  return withImmediateTransaction((db) => {
    const timestamp = new Date().toISOString();
    db.prepare('DELETE FROM write_leases WHERE expires_at <= ?').run(timestamp);
    const maintenance = readState(db);
    if (maintenance.active) {
      throw new MaintenanceError(maintenance.reason || '系统维护中', 'MAINTENANCE', 503);
    }
    const lease: WriteLeaseRecord = {
      id: randomUUID(),
      owner,
      kind: normalizedKind,
      acquiredAt: timestamp,
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    };
    db.prepare(
      'INSERT INTO write_leases (id, owner, kind, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(lease.id, lease.owner, lease.kind, lease.acquiredAt, lease.expiresAt);
    return lease;
  });
}

/** Extend only a currently live lease. An expired row is never resurrected,
 * even if no waiter has deleted it yet. Existing leases may renew after
 * maintenance begins so the protected operation can finish and drain. */
export function renewWriteLease(lease: WriteLeaseRecord, ttlMs?: number): WriteLeaseRecord {
  validateWriteLeaseIdentity(lease);
  const boundedTtlMs = writeLeaseMs(ttlMs);
  return withImmediateTransaction((db) => {
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + boundedTtlMs).toISOString();
    const result = db.prepare(
      `UPDATE write_leases
       SET expires_at = ?
       WHERE id = ? AND owner = ? AND expires_at > ?`
    ).run(expiresAt, lease.id, lease.owner, timestamp);
    if (result.changes !== 1) {
      db.prepare('DELETE FROM write_leases WHERE id = ? AND expires_at <= ?').run(lease.id, timestamp);
      throw writeLeaseLost();
    }
    return { ...lease, expiresAt };
  });
}

/** Verify ownership and expiry without extending the deadline. */
export function assertWriteLeaseActive(lease: WriteLeaseRecord): WriteLeaseRecord {
  validateWriteLeaseIdentity(lease);
  const timestamp = new Date().toISOString();
  const row = getDb().prepare(
    'SELECT id, owner, kind, acquired_at, expires_at FROM write_leases WHERE id = ? AND owner = ?'
  ).get(lease.id, lease.owner) as WriteLeaseRow | undefined;
  if (!row || row.expires_at <= timestamp) {
    if (row) getDb().prepare('DELETE FROM write_leases WHERE id = ? AND expires_at <= ?').run(lease.id, timestamp);
    throw writeLeaseLost();
  }
  return mapWriteLease(row);
}

/** Idempotently release a lease. Ownership is required so a stale caller
 * cannot delete a replacement lease row. */
export function releaseWriteLease(lease: Pick<WriteLeaseRecord, 'id' | 'owner'>): boolean {
  if (!isUuid(lease.id) || typeof lease.owner !== 'string' || !lease.owner) return false;
  return getDb().prepare('DELETE FROM write_leases WHERE id = ? AND owner = ?').run(lease.id, lease.owner).changes === 1;
}

/** Run an asynchronous write while a cross-process lease is heartbeated.
 * The callback must use assertActive()/renew() at irreversible boundaries;
 * the upload service does so before every durable commit. */
export async function withWriteLease<T>(
  kind: string,
  operation: (context: WriteLeaseContext) => Promise<T> | T,
  options: WriteLeaseOptions = {}
): Promise<T> {
  let lease = acquireWriteLease(kind, options);
  let lost: WriteLeaseError | null = null;
  const context: WriteLeaseContext = {
    get lease() { return lease; },
    renew(ttlMs?: number) {
      if (lost) throw lost;
      try {
        lease = renewWriteLease(lease, ttlMs);
        return lease;
      } catch (error) {
        lost = asWriteLeaseError(error);
        throw error;
      }
    },
    assertActive() {
      if (lost) throw lost;
      try {
        lease = assertWriteLeaseActive(lease);
        return lease;
      } catch (error) {
        lost = asWriteLeaseError(error);
        throw error;
      }
    }
  };
  const heartbeatMs = Math.max(500, Math.floor(writeLeaseMs(options.ttlMs) / 3));
  const heartbeat = options.heartbeat === false ? undefined : setInterval(() => {
    try { context.renew(); } catch { /* callback checkpoints surface the loss */ }
  }, heartbeatMs);
  heartbeat?.unref();
  try {
    const result = await operation(context);
    // A timer can observe expiry while the callback is awaiting an external
    // filesystem operation. Surface that loss even when the callback did not
    // happen to reach another explicit checkpoint afterwards.
    if (lost) throw lost;
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releaseWriteLease(lease);
  }
}

/** Protect a short synchronous database mutation with the same durable fence
 * used by asynchronous writers. The default one-minute lease is deliberately
 * much longer than these local SQLite transactions. */
export function withWriteLeaseSync<T>(
  kind: string,
  operation: (context: WriteLeaseContext) => T,
  options: WriteLeaseOptions = {}
): T {
  let lease = acquireWriteLease(kind, options);
  const context: WriteLeaseContext = {
    get lease() { return lease; },
    renew(ttlMs?: number) {
      lease = renewWriteLease(lease, ttlMs);
      return lease;
    },
    assertActive() {
      lease = assertWriteLeaseActive(lease);
      return lease;
    }
  };
  try {
    context.renew();
    return operation(context);
  } finally {
    releaseWriteLease(lease);
  }
}

/** Wait until all non-expired writes have drained. Callers taking a backup or
 * switching the database should pass their maintenance owner so losing that
 * marker fails closed rather than returning a racy success. */
export async function waitForWriteLeases(options: WaitForWriteLeasesOptions = {}): Promise<void> {
  const timeoutMs = writeLeaseWaitMs(options.timeoutMs);
  const pollIntervalMs = Number.isSafeInteger(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) >= 1
    ? Math.min(options.pollIntervalMs!, 1_000)
    : 100;
  const owner = options.maintenanceOwner ? normalizeOwner(options.maintenanceOwner) : undefined;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = withImmediateTransaction((db) => {
      const timestamp = new Date().toISOString();
      db.prepare('DELETE FROM write_leases WHERE expires_at <= ?').run(timestamp);
      if (owner) {
        const state = readState(db);
        if (!state.active || state.owner !== owner) {
          throw new MaintenanceError('等待写入结束时维护模式所有权已丢失', 'MAINTENANCE_OWNER', 409);
        }
      }
      const row = db.prepare('SELECT COUNT(*) AS count FROM write_leases WHERE expires_at > ?').get(timestamp) as { count: number };
      return Number(row.count);
    });
    if (remaining === 0) return;
    if (Date.now() >= deadline) {
      throw new WriteLeaseError(`等待 ${remaining} 个写入租约结束超时`, 'WRITE_LEASE_TIMEOUT', 409, false);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}

export function isMaintenanceError(error: unknown): error is MaintenanceError {
  return error instanceof MaintenanceError;
}

export function isWriteLeaseError(error: unknown): error is WriteLeaseError {
  return error instanceof WriteLeaseError;
}

interface WriteLeaseRow {
  id: string;
  owner: string;
  kind: string;
  acquired_at: string;
  expires_at: string;
}

function mapWriteLease(row: WriteLeaseRow): WriteLeaseRecord {
  return {
    id: row.id,
    owner: row.owner,
    kind: row.kind,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  };
}

function normalizeWriteLeaseKind(kind: string): string {
  const normalized = typeof kind === 'string' ? kind.trim() : '';
  if (!/^[a-z0-9._:-]{1,64}$/i.test(normalized)) {
    throw new TypeError('写入租约类型无效');
  }
  return normalized;
}

function normalizeWriteLeaseOwner(owner: string): string {
  const normalized = typeof owner === 'string' ? owner.trim().slice(0, 256) : '';
  if (!normalized) throw new TypeError('写入租约必须有所有者');
  return normalized;
}

function validateWriteLeaseIdentity(lease: WriteLeaseRecord): void {
  if (!lease || !isUuid(lease.id) || !lease.owner) throw writeLeaseLost();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function writeLeaseLost(): WriteLeaseError {
  return new WriteLeaseError('写入租约已过期或被回收，操作已中止', 'WRITE_LEASE_LOST', 409);
}

function asWriteLeaseError(error: unknown): WriteLeaseError {
  return error instanceof WriteLeaseError
    ? error
    : new WriteLeaseError('写入租约无法续期，操作已中止', 'WRITE_LEASE_LOST', 409);
}
