import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MAINTENANCE_SETTING_KEY, MaintenanceError } from './maintenance-types';

export type SqliteDatabase = Database.Database;

/** Raised when a restore switch journal proves that the live pathname is in a
 * non-atomic intermediate state.  Callers must keep maintenance active and
 * let the recovery worker/operator finish the journal; opening a brand-new
 * empty SQLite file here would be data-destructive. */
export class DatabaseRecoveryRequiredError extends Error {
  readonly code = 'DATABASE_RECOVERY_REQUIRED';
  readonly status = 503;
  constructor(message = '数据库正在恢复或需要人工恢复；为防止创建空数据库，服务已停止写入') {
    super(message);
    this.name = 'DatabaseRecoveryRequiredError';
  }
}

let singleton: SqliteDatabase | null = null;
let migrationPromise: Promise<void> | null = null;
let singletonPath: string | null = null;
let singletonIdentity: string | null = null;
let databaseGeneration = 0;

function databasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) {
    assertSafeProductionDatabasePath(configured);
    return configured;
  }
  // Never place live SQLite state in the OneDrive source tree. Compose sets
  // /data/app.db (a named Docker/WSL2 volume); local development falls back to
  // the host's temporary application-data directory.
  return process.env.NODE_ENV === 'test' ? ':memory:' : path.join(os.tmpdir(), 'jiawang-warehouse', 'app.db');
}

function assertSafeProductionDatabasePath(value: string): void {
  if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_UNSAFE_LOCAL_STORAGE === 'true') return;
  if (value === ':memory:' || value.startsWith('file:')) {
    throw new Error('生产数据库必须使用 Docker/WSL2 命名卷中的普通文件路径');
  }
  const resolved = path.resolve(value);
  if (/onedrive/i.test(resolved) || /^\\\\/.test(resolved) || /(?:^|[\\/])(?:smb|network)(?:[\\/]|$)/i.test(resolved)) {
    throw new Error('生产数据库不得位于 OneDrive、SMB 或网络盘');
  }
}

function ensureParentDirectory(filePath: string): void {
  if (filePath === ':memory:' || filePath.startsWith('file:')) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function applyPragmas(db: SqliteDatabase): void {
  // These are intentionally set on every connection because SQLite pragmas are
  // connection scoped. WAL keeps web and worker readers from blocking writers.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

function migrationDirectory(): string {
  return path.join(process.cwd(), 'migrations');
}

export function runMigrations(db: SqliteDatabase = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const files = fs.existsSync(migrationDirectory())
    ? fs.readdirSync(migrationDirectory())
        .filter((file) => /^\d+[_-].+\.sql$/i.test(file))
        .sort((a, b) => a.localeCompare(b, 'en'))
    : [];
  // BEGIN IMMEDIATE serializes migration runners in web/worker containers.
  // Read the applied set only after acquiring that lock. Reading it before
  // BEGIN would let web and worker both observe a stale empty set; the second
  // process would then replay non-idempotent ALTER TABLE migrations after the
  // first commits.
  db.exec('BEGIN IMMEDIATE');
  try {
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
        (row) => row.version
      )
    );
    const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationDirectory(), file), 'utf8');
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}

export function getDb(): SqliteDatabase {
  const filePath = databasePath();
  if (singleton) {
    // A restore replaces the SQLite file atomically. Other long-lived
    // processes (notably the web container) may still hold a connection to
    // the pre-restore inode. Detect that replacement before serving the next
    // request and reopen the database instead of continuing on split-brain
    // state. A temporarily missing path is kept on the old, maintenance-gated
    // connection until the atomic switch has completed.
    const currentIdentity = databaseFileIdentity(filePath);
    if (singletonPath === filePath && (!currentIdentity || currentIdentity === singletonIdentity)) {
      // A restore worker writes its sidecar before moving any pathname.  Check
      // it even when the inode has not changed yet; otherwise a long-lived web
      // process could continue serving the pre-switch connection through an
      // uncertain recovery window.
      assertNoInterruptedRestoreSwitch(filePath);
      return singleton;
    }
    closeDb();
  }
  assertNoInterruptedRestoreSwitch(filePath);
  ensureParentDirectory(filePath);
  singleton = new Database(filePath, { timeout: 5000 });
  applyPragmas(singleton);
  // Migrations are synchronous and protected by BEGIN IMMEDIATE. The promise
  // guard is retained for callers that initialize from async bootstrap code.
  runMigrations(singleton);
  singletonPath = filePath;
  singletonIdentity = databaseFileIdentity(filePath);
  databaseGeneration += 1;
  return singleton;
}

function assertNoInterruptedRestoreSwitch(filePath: string): void {
  if (filePath === ':memory:' || filePath.startsWith('file:')) return;
  const journalPath = `${path.resolve(filePath)}.restore-journal.json`;
  let journalStat: fs.Stats;
  try {
    journalStat = fs.lstatSync(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DatabaseRecoveryRequiredError('无法读取数据库恢复 journal；已阻断启动');
  }
  if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
    throw new DatabaseRecoveryRequiredError('数据库恢复 journal 不是受控普通文件；已阻断启动');
  }
  let journal: { phase?: unknown; livePath?: unknown } = {};
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as typeof journal;
  } catch {
    throw new DatabaseRecoveryRequiredError('数据库恢复日志损坏；请先由管理员完成恢复或回滚');
  }
  if (journal.livePath && path.resolve(String(journal.livePath)) !== path.resolve(filePath)) {
    throw new DatabaseRecoveryRequiredError('数据库恢复日志路径不匹配；已阻断启动');
  }
  const phase = String(journal.phase || '');
  if (!['switching', 'switched', 'rollback_failed'].includes(phase)) {
    throw new DatabaseRecoveryRequiredError('数据库恢复日志阶段无效；已阻断启动');
  }
  const livePath = path.resolve(filePath);
  if (journal.livePath && path.resolve(String(journal.livePath)) !== livePath) {
    throw new DatabaseRecoveryRequiredError('数据库恢复 journal 路径不匹配；已阻断启动');
  }
  const candidate = journal as Record<string, unknown>;
  const absolutePath = (key: string): string => {
    const value = candidate[key];
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new DatabaseRecoveryRequiredError('数据库恢复 journal 路径字段无效；已阻断启动');
    return path.resolve(value);
  };
  const rollbackPath = absolutePath('rollbackPath');
  const restoredPath = absolutePath('restoredPath');
  const stagingPath = absolutePath('stagingPath');
  const inputPath = absolutePath('inputPath');
  const liveBase = path.basename(livePath);
  if (path.dirname(rollbackPath) !== path.dirname(livePath) || !path.basename(rollbackPath).startsWith(`${liveBase}.pre-restore-`)) {
    throw new DatabaseRecoveryRequiredError('数据库恢复 journal 回滚路径无效；已阻断启动');
  }
  const restoredBase = path.basename(restoredPath);
  if (path.dirname(restoredPath) !== path.dirname(livePath)
    || !restoredBase.startsWith(`.${liveBase}.restore-`)
    || !restoredBase.endsWith('.staged')) {
    throw new DatabaseRecoveryRequiredError('数据库恢复 journal 同卷 staging 路径无效；已阻断启动');
  }
  const backupRoot = path.resolve(process.env.BACKUP_OUT_DIR?.trim() || path.join(process.cwd(), '.local', 'backups'));
  const backupPrefix = `${backupRoot}${path.sep}`;
  if (!stagingPath.startsWith(backupPrefix) || !inputPath.startsWith(`${path.join(backupRoot, '.incoming')}${path.sep}`)) {
    throw new DatabaseRecoveryRequiredError('数据库恢复 journal staging/input 路径不受控；已阻断启动');
  }
  const regular = (value: string): fs.Stats | null => {
    try {
      const stat = fs.lstatSync(value);
      return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
    } catch { return null; }
  };
  const live = regular(livePath);
  const rollback = regular(rollbackPath);
  const restored = regular(restoredPath);
  if (phase === 'rollback_failed') throw new DatabaseRecoveryRequiredError();
  // Before the first move, the old live DB and staged replacement coexist.
  // Once either pathname move has happened, both generations must be visible
  // until the restore worker proves a commit/rollback; opening an ambiguous
  // single file would risk a split-brain write.
  if (phase === 'switching') {
    if (!live || !restored || rollback) throw new DatabaseRecoveryRequiredError();
    return;
  }
  if (!live || !rollback || restored) throw new DatabaseRecoveryRequiredError();
}

/** Monotonically changes whenever this process opens a different live DB. */
export function getDatabaseGeneration(): number {
  return databaseGeneration;
}

export async function ensureDatabase(): Promise<SqliteDatabase> {
  if (!migrationPromise) {
    migrationPromise = Promise.resolve().then(() => getDb()).then(() => undefined);
  }
  await migrationPromise;
  return getDb();
}

/**
 * Options for the database write boundary.
 *
 * A normal transaction is rejected while the durable maintenance marker is
 * active.  Maintenance/restore workers may explicitly pass the exact owner
 * encoded in that marker for the small set of bookkeeping writes that must
 * remain possible while the fence is held.  The owner is intentionally an
 * opt-in escape hatch rather than a boolean bypass, so a stale/different
 * worker cannot write through another operation's fence.
 */
export interface TransactionOptions {
  maintenanceOwner?: string;
}

interface MaintenanceMarkerRow {
  value?: unknown;
}

/**
 * Read and validate the marker using the transaction's already-open
 * connection.  Calling `getMaintenanceState()` here would perform another
 * connection/identity lookup while a SQLite transaction is active and could
 * close a generation that a restore worker is currently fencing.  Invalid or
 * partially-written marker values are treated as active (fail-closed).
 */
function assertWriteBoundaryOpen(db: SqliteDatabase, maintenanceOwner?: string): void {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(MAINTENANCE_SETTING_KEY) as MaintenanceMarkerRow | undefined;
  if (!row) return;

  const raw = row.value;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new MaintenanceError('缁存姢鐘舵€佹棤娉曢獙璇侊紝宸查樆鏂啓鍏?', 'MAINTENANCE', 503);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaintenanceError('缁存姢鐘舵€佹崯鍧忥紝宸查樆鏂啓鍏?', 'MAINTENANCE', 503);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MaintenanceError('缁存姢鐘舵€佹棤鏁堬紝宸查樆鏂啓鍏?', 'MAINTENANCE', 503);
  }

  const marker = parsed as { active?: unknown; owner?: unknown; reason?: unknown };
  if (marker.active === false) return;
  if (marker.active !== true) {
    throw new MaintenanceError('缁存姢鐘舵€佹棤娉曠‘璁わ紝宸查樆鏂啓鍏?', 'MAINTENANCE', 503);
  }

  const owner = typeof marker.owner === 'string' ? marker.owner : '';
  const requestedOwner = typeof maintenanceOwner === 'string'
    ? maintenanceOwner.trim().slice(0, 256)
    : '';
  if (requestedOwner && owner && requestedOwner === owner) return;

  const reason = typeof marker.reason === 'string' && marker.reason.trim()
    ? marker.reason.trim().slice(0, 500)
    : '系统维护中';
  throw new MaintenanceError(reason, 'MAINTENANCE', 503);
}

/**
 * Execute a synchronous SQLite mutation under the maintenance fence.
 * `BEGIN IMMEDIATE` is important here: it serializes the marker check with
 * `enterMaintenanceMode()`.  A deferred read followed by a write would leave
 * a check-then-commit window in which a backup could drain and snapshot while
 * this transaction was still able to start writing.
 */
export function withTransaction<T>(fn: (db: SqliteDatabase) => T, options: TransactionOptions = {}): T {
  const db = getDb();
  return db.transaction(() => {
    assertWriteBoundaryOpen(db, options.maintenanceOwner);
    return fn(db);
  }).immediate();
}

/** Explicitly named form for maintenance/restore bookkeeping writes. */
export function withMaintenanceTransaction<T>(
  maintenanceOwner: string,
  fn: (db: SqliteDatabase) => T,
): T {
  return withTransaction(fn, { maintenanceOwner });
}

export function cleanupExpiredSessions(now = new Date().toISOString()): number {
  try {
    return withTransaction((db) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  } catch (error) {
    // Cleanup must never make a health/read path fail solely because a backup
    // fence is active; the next request/worker poll will try again.
    if (error instanceof Error && ['MAINTENANCE', 'MAINTENANCE_BUSY'].includes(String((error as { code?: unknown }).code))) return 0;
    throw error;
  }
}

export function healthCheck(): { ok: boolean; journalMode: string; migrations: number } {
  const db = getDb();
  const journalMode = String((db.pragma('journal_mode', { simple: true }) as string) ?? 'unknown');
  const row = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
  return { ok: true, journalMode, migrations: Number(row.count) };
}

export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
    migrationPromise = null;
  }
  singletonPath = null;
  singletonIdentity = null;
}

function databaseFileIdentity(filePath: string): string | null {
  if (filePath === ':memory:' || filePath.startsWith('file:')) return null;
  try {
    const stat = fs.statSync(path.resolve(filePath), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return null;
  }
}
