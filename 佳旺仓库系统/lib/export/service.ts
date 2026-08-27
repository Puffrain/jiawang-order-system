import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { getDb, withTransaction } from '../db';
import { withWriteLease } from '../maintenance';
import { spreadsheetSafe, PRODUCT_EXPORT_HEADERS } from './csv';

export type ExportFormat = 'csv' | 'xlsx' | 'image_manifest';
export type ExportStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExportJobRecord {
  id: string;
  format: ExportFormat;
  status: ExportStatus;
  requestedBy: string;
  outputPath: string | null;
  rowCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ExportLimits { maxRows: number; maxBytes: number; }
interface ExportRow {
  product_id: string;
  product_name: string;
  brand: string | null;
  category_id: string;
  status: string;
  specification: string;
  sku: string | null;
  barcode: string | null;
  barcode_symbology: string | null;
  net_content: string | null;
  unit: string | null;
  packaging: string | null;
  ingredients: string | null;
  efficacy: string | null;
  directions: string | null;
  warnings: string | null;
  country_of_origin: string | null;
  manufacturer: string | null;
  license_number: string | null;
  batch_number: string | null;
  production_date: string | null;
  shelf_life: string | null;
  expiry_date: string | null;
  notes: string | null;
  reviewed_by: string | null;
  published_at: string | null;
}
interface ImageManifestRow { product_id: string; name: string; asset_id: string; is_primary: number; }

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_PER_USER = 2;
const MAX_ACTIVE_GLOBAL = 4;
const EXPORT_LEASE_TTL_MS = 15 * 60 * 1000;
const EXPORT_CLEANUP_LEASE_TTL_MS = 5 * 60 * 1000;

export class ExportQueueError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 429) {
    super(message);
    this.name = 'ExportQueueError';
    this.code = code;
    this.status = status;
  }
}

function exportRoot(): string {
  const base = process.env.DATA_DIR?.trim() || path.join(process.cwd(), '.local');
  return path.resolve(base, 'exports');
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function exportLimits(): ExportLimits {
  return {
    maxRows: integerEnv('EXPORT_MAX_ROWS', DEFAULT_MAX_ROWS, 1, 500_000),
    maxBytes: integerEnv('EXPORT_MAX_BYTES', DEFAULT_MAX_BYTES, 1_048_576, 4 * 1024 * 1024 * 1024),
  };
}

function mapRow(row: Record<string, unknown>): ExportJobRecord {
  const rawOutput = row.output_path == null ? null : String(row.output_path);
  return {
    id: String(row.id),
    format: row.format as ExportFormat,
    status: row.status as ExportStatus,
    requestedBy: String(row.requested_by),
    outputPath: rawOutput ? path.basename(rawOutput) : null,
    rowCount: Number(row.row_count || 0),
    // Do not expose SQL/provider/filesystem details stored by the worker.
    errorMessage: row.error_message == null ? null : '导出失败，请查看任务日志或重试',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export function getExportJob(id: string): ExportJobRecord | null {
  const row = getDb().prepare('SELECT * FROM export_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function listExportJobs(requestedBy?: string): ExportJobRecord[] {
  const rows = (requestedBy
    ? getDb().prepare('SELECT * FROM export_jobs WHERE requested_by = ? ORDER BY created_at DESC LIMIT 100').all(requestedBy)
    : getDb().prepare('SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT 100').all()) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Queue only. The worker owns all potentially expensive catalogue reads and
 * file generation, so a browser request cannot consume a Web request slot for
 * the duration of an export. */
export function createPublishedExport(format: ExportFormat, requestedBy: string): ExportJobRecord {
  if (!['csv', 'xlsx', 'image_manifest'].includes(format)) throw new Error('不支持的导出格式');
  const id = `export-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const limits = exportLimits();
  withTransaction((db) => {
    const activeForUser = db.prepare("SELECT COUNT(*) AS count FROM export_jobs WHERE requested_by = ? AND status IN ('queued','running')").get(requestedBy) as { count: number };
    if (Number(activeForUser.count) >= MAX_ACTIVE_PER_USER) throw new ExportQueueError('EXPORT_USER_QUEUE_LIMIT', '该账号已有导出任务在处理，请稍后再试');
    const activeGlobal = db.prepare("SELECT COUNT(*) AS count FROM export_jobs WHERE status IN ('queued','running')").get() as { count: number };
    if (Number(activeGlobal.count) >= MAX_ACTIVE_GLOBAL) throw new ExportQueueError('EXPORT_QUEUE_LIMIT', '导出队列已满，请稍后再试');
    db.prepare(`INSERT INTO export_jobs
      (id, format, status, requested_by, filter_json, row_count, max_rows, max_bytes, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)`)
      .run(id, format, requestedBy, JSON.stringify({ status: 'published' }), limits.maxRows, limits.maxBytes, timestamp, timestamp);
  });
  return getExportJob(id)!;
}

/** Recover a crashed claim, then process at most `limit` durable rows. */
export async function processQueuedExports(limit = 1): Promise<ExportJobRecord[]> {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 4);
  const now = new Date().toISOString();
  // A lease is the fencing source of truth. Expired running rows are safe to
  // return to queued because their output is written to a generation-specific
  // staging file and committed by an owner-conditional update.
  withTransaction((db) => {
    // The export row lease and the process write lease are two parts of the
    // same fence. A synchronous XLSX build can temporarily delay the JS
    // heartbeat; do not steal a row while its matching write lease is still
    // alive. A crashed worker has no live write-lease row and remains
    // recoverable on the next poll.
    db.prepare("UPDATE export_jobs SET status='queued', lease_owner=NULL, lease_acquired_at=NULL, lease_expires_at=NULL, updated_at=? WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND NOT EXISTS (SELECT 1 FROM write_leases wl WHERE wl.owner = export_jobs.lease_owner AND wl.expires_at > ?)").run(now, now, now);
  });
  const rows = getDb().prepare("SELECT id FROM export_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT ?").all(bounded) as Array<{ id: string }>;
  const result: ExportJobRecord[] = [];
  for (const row of rows) {
    try {
      const processed = await processExport(row.id);
      if (processed) result.push(processed);
    } catch {
      const current = getExportJob(row.id);
      if (current) result.push(current);
    }
  }
  await cleanupExpiredExports();
  return result;
}

async function processExport(id: string): Promise<ExportJobRecord | null> {
  const attemptId = randomUUID();
  const owner = `export:${process.pid}:${attemptId}`;
  try {
    return await withWriteLease('export.generate', async (lease) => {
      const claimed = claimExport(id, owner);
      if (!claimed) return null;
      const limits = { maxRows: claimed.maxRows, maxBytes: claimed.maxBytes };
      const root = exportRoot();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const extension = claimed.format === 'xlsx' ? 'xlsx' : 'csv';
      const temp = path.join(root, `.${id}.${attemptId}.tmp`);
      // Every claim publishes to its own immutable pathname. If this worker's
      // lease expires between the last check and filesystem publication, a
      // replacement worker uses a different name and cannot be overwritten.
      const output = path.join(root, `${id}.${attemptId}.${extension}`);
      let published = false;
      try {
        const rowCount = claimed.format === 'xlsx'
          ? await writeXlsx(temp, limits)
          : claimed.format === 'image_manifest'
            ? await writeImageManifest(temp, limits)
            : await writeCsv(temp, limits);
        renewExportClaim(id, owner, lease);
        await ensureFileWithinLimit(temp, limits.maxBytes);
        lease.assertActive();
        await publishExportExclusive(temp, output);
        published = true;
        const committed = withTransaction((db) => {
          const timestamp = new Date().toISOString();
          return db.prepare(`UPDATE export_jobs SET status='completed', output_path=?, row_count=?, updated_at=?, completed_at=?, lease_owner=NULL, lease_acquired_at=NULL, lease_expires_at=NULL, error_message=NULL WHERE id=? AND status='running' AND lease_owner=?`).run(output, rowCount, timestamp, timestamp, id, owner).changes === 1;
        });
        if (!committed) throw new Error('导出任务租约已失效');
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined);
        if (published) await fs.rm(output, { force: true }).catch(() => undefined);
        throw error;
      }
      return getExportJob(id);
    }, { owner, ttlMs: EXPORT_LEASE_TTL_MS });
  } catch (error) {
    // A lost lease must remain recoverable. Do not write through another
    // worker's claim; the stale-lease recovery pass will requeue it.
    if (error instanceof Error && (error as { code?: unknown }).code === 'WRITE_LEASE_LOST') return getExportJob(id);
    try {
      withTransaction((db) => db.prepare("UPDATE export_jobs SET status='failed', error_message=?, updated_at=?, lease_owner=NULL, lease_acquired_at=NULL, lease_expires_at=NULL WHERE id=? AND status='running' AND lease_owner=?").run('EXPORT_FAILED', new Date().toISOString(), id, owner));
    } catch { /* retain queued/running row for durable recovery */ }
    return getExportJob(id);
  }
}

function renewExportClaim(id: string, owner: string, lease: { renew(): unknown }): void {
  lease.renew();
  const acquired = new Date().toISOString();
  const expires = new Date(Date.now() + EXPORT_LEASE_TTL_MS).toISOString();
  const result = withTransaction((db) => db.prepare("UPDATE export_jobs SET lease_acquired_at=?, lease_expires_at=?, updated_at=? WHERE id=? AND status='running' AND lease_owner=?").run(acquired, expires, acquired, id, owner));
  if (result.changes !== 1) throw new Error('导出任务租约已失效');
}

interface ClaimedExport { id: string; format: ExportFormat; maxRows: number; maxBytes: number; }
function claimExport(id: string, owner: string): ClaimedExport | null {
  const now = new Date();
  const acquired = now.toISOString();
  const expires = new Date(now.getTime() + EXPORT_LEASE_TTL_MS).toISOString();
  return withTransaction((db) => {
    const row = db.prepare('SELECT id, format, status, lease_expires_at, max_rows, max_bytes FROM export_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row || row.status === 'completed' || row.status === 'failed') return null;
    if (row.status === 'running' && row.lease_expires_at && String(row.lease_expires_at) > acquired) return null;
    const result = db.prepare("UPDATE export_jobs SET status='running', lease_owner=?, lease_acquired_at=?, lease_expires_at=?, attempt_count=attempt_count+1, updated_at=? WHERE id=? AND (status='queued' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))").run(owner, acquired, expires, acquired, id, acquired);
    if (result.changes !== 1) return null;
    return { id, format: row.format as ExportFormat, maxRows: Number(row.max_rows) || DEFAULT_MAX_ROWS, maxBytes: Number(row.max_bytes) || DEFAULT_MAX_BYTES };
  });
}

async function writeCsv(filePath: string, limits: ExportLimits): Promise<number> {
  const fd = fsSync.openSync(filePath, 'wx', 0o600);
  let bytes = 0;
  let count = 0;
  try {
    const write = (value: string) => {
      const buffer = Buffer.from(value, 'utf8');
      bytes += buffer.byteLength;
      if (bytes > limits.maxBytes) throw new ExportQueueError('EXPORT_SIZE_LIMIT', '导出文件超过大小限制', 413);
      fsSync.writeSync(fd, buffer);
    };
    write(`\uFEFF${PRODUCT_EXPORT_HEADERS.map(csvCell).join(',')}\r\n`);
    forEachVariantRow(limits.maxRows, (row) => { write(`${rowToCsv(row)}\r\n`); count += 1; });
    fsSync.fsyncSync(fd);
  } finally { fsSync.closeSync(fd); }
  return count;
}

async function writeImageManifest(filePath: string, limits: ExportLimits): Promise<number> {
  const fd = fsSync.openSync(filePath, 'wx', 0o600);
  let bytes = 0;
  let count = 0;
  try {
    const write = (value: string) => {
      const buffer = Buffer.from(value, 'utf8');
      bytes += buffer.byteLength;
      if (bytes > limits.maxBytes) throw new ExportQueueError('EXPORT_SIZE_LIMIT', '导出文件超过大小限制', 413);
      fsSync.writeSync(fd, buffer);
    };
    write('\uFEFF"商品ID","商品名称","图片资产ID","是否主图"\r\n');
    forEachManifestRow(limits.maxRows, (row) => { write([row.product_id, row.name, row.asset_id, row.is_primary ? '是' : '否'].map(csvCell).join(',') + '\r\n'); count += 1; });
    fsSync.fsyncSync(fd);
  } finally { fsSync.closeSync(fd); }
  return count;
}

async function writeXlsx(filePath: string, limits: ExportLimits): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '佳旺美容美发商品录入系统';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('已发布商品', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = PRODUCT_EXPORT_HEADERS.map((header) => ({ header, key: header, width: Math.max(12, Math.min(36, header.length * 2 + 4)) }));
  let count = 0;
  forEachVariantRow(limits.maxRows, (row) => { sheet.addRow(rowToValues(row)); count += 1; });
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  sheet.autoFilter = { from: 'A1', to: `Z${Math.max(1, sheet.rowCount)}` };
  await workbook.xlsx.writeFile(filePath);
  await fs.chmod(filePath, 0o600);
  return count;
}

function forEachVariantRow(maxRows: number, callback: (row: ExportRow) => void): void {
  const db = getDb();
  let count = 0;
  const run = db.transaction(() => {
    const rows = db.prepare(`SELECT p.id AS product_id, p.name AS product_name, p.brand, p.category_id, p.status,
      v.specification, v.sku, COALESCE(v.barcode_normalized, v.barcode_raw) AS barcode,
      v.barcode_symbology, v.net_content, v.unit, v.packaging, p.ingredients, p.efficacy, p.directions,
      p.warnings, p.country_of_origin, p.manufacturer, p.license_number, p.batch_number,
      p.production_date, p.shelf_life, p.expiry_date, p.notes, p.reviewed_by, p.published_at
      FROM products p JOIN product_variants v ON v.product_id = p.id
      WHERE p.status='published' ORDER BY p.id, v.id`).iterate() as Iterable<ExportRow>;
    for (const row of rows) {
      if (count >= maxRows) throw new ExportQueueError('EXPORT_ROW_LIMIT', '导出记录超过行数限制', 413);
      callback(row);
      count += 1;
    }
  });
  run();
}

function forEachManifestRow(maxRows: number, callback: (row: ImageManifestRow) => void): void {
  const db = getDb();
  let count = 0;
  const run = db.transaction(() => {
    const rows = db.prepare(`SELECT p.id AS product_id, p.name, pa.asset_id, pa.is_primary
      FROM products p JOIN product_assets pa ON pa.product_id=p.id
      WHERE p.status='published' ORDER BY p.id, pa.sort_order, pa.asset_id`).iterate() as Iterable<ImageManifestRow>;
    for (const row of rows) {
      if (count >= maxRows) throw new ExportQueueError('EXPORT_ROW_LIMIT', '导出记录超过行数限制', 413);
      callback(row);
      count += 1;
    }
  });
  run();
}

function rowToValues(row: ExportRow): string[] {
  return [row.product_id, row.product_name, row.brand ?? '', row.category_id, row.status, row.specification,
    row.sku ?? '', row.barcode ?? '', row.barcode_symbology ?? '', row.net_content ?? '', row.unit ?? '', row.packaging ?? '',
    row.ingredients ?? '', row.efficacy ?? '', row.directions ?? '', row.warnings ?? '', row.country_of_origin ?? '', row.manufacturer ?? '',
    row.license_number ?? '', row.batch_number ?? '', row.production_date ?? '', row.shelf_life ?? '', row.expiry_date ?? '', row.notes ?? '',
    row.reviewed_by ?? '', row.published_at ?? ''].map(spreadsheetSafe);
}
function csvCell(value: unknown): string { return `"${spreadsheetSafe(value).replaceAll('"', '""')}"`; }
function rowToCsv(row: ExportRow): string { return rowToValues(row).map(csvCell).join(','); }

async function ensureFileWithinLimit(filePath: string, maxBytes: number): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new ExportQueueError('EXPORT_SIZE_LIMIT', '导出文件超过大小限制', 413);
}

async function publishExportExclusive(temp: string, output: string): Promise<void> {
  let published = false;
  try {
    // link() gives an atomic no-clobber publication on the normal named
    // volume path. Never replace an operator file or another attempt's bytes.
    try {
      await fs.link(temp, output);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(String(code))) throw error;
      await fs.copyFile(temp, output, fsSync.constants.COPYFILE_EXCL);
    }
    published = true;
    const handle = await fs.open(output, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rm(temp, { force: true });
  } catch (error) {
    if (published) await fs.rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function cleanupExpiredExports(): Promise<void> {
  const days = integerEnv('EXPORT_RETENTION_DAYS', 14, 1, 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const timestamp = new Date().toISOString();
  const rows = getDb().prepare("SELECT id FROM export_jobs WHERE status='completed' AND completed_at IS NOT NULL AND completed_at < ? AND (cleanup_expires_at IS NULL OR cleanup_expires_at <= ?) LIMIT 100").all(cutoff, timestamp) as Array<{ id: string }>;
  for (const row of rows) {
    const owner = `export-cleanup:${process.pid}:${randomUUID()}`;
    try {
      await withWriteLease('export.cleanup', async (lease) => {
        const claimed = claimExpiredExport(row.id, cutoff, owner);
        if (!claimed) return;
        lease.renew(EXPORT_CLEANUP_LEASE_TTL_MS);
        if (claimed.outputPath) {
          const artifact = resolveManagedExportPath(claimed.id, claimed.format, claimed.outputPath);
          await fs.rm(artifact, { force: true });
        }
        lease.assertActive();
        const removed = withTransaction((db) => db.prepare(`DELETE FROM export_jobs
          WHERE id=? AND status='completed' AND completed_at < ? AND cleanup_owner=?`).run(claimed.id, cutoff, owner));
        if (removed.changes !== 1) throw new Error('导出清理所有权已失效');
      }, { owner, ttlMs: EXPORT_CLEANUP_LEASE_TTL_MS });
    } catch {
      // A crash or lost claim is recoverable. Clear only this owner's claim;
      // another worker may already have reclaimed an expired generation.
      try {
        withTransaction((db) => db.prepare(`UPDATE export_jobs
          SET cleanup_owner=NULL, cleanup_expires_at=NULL
          WHERE id=? AND status='completed' AND cleanup_owner=?`).run(row.id, owner));
      } catch { /* maintenance keeps the durable claim until expiry */ }
    }
  }
}

interface ClaimedExpiredExport { id: string; format: ExportFormat; outputPath: string | null; }
function claimExpiredExport(id: string, cutoff: string, owner: string): ClaimedExpiredExport | null {
  const claimedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXPORT_CLEANUP_LEASE_TTL_MS).toISOString();
  return withTransaction((db) => {
    const row = db.prepare(`SELECT id, format, output_path FROM export_jobs
      WHERE id=? AND status='completed' AND completed_at IS NOT NULL AND completed_at < ?
      AND (cleanup_expires_at IS NULL OR cleanup_expires_at <= ?)`)
      .get(id, cutoff, claimedAt) as { id: string; format: ExportFormat; output_path: string | null } | undefined;
    if (!row) return null;
    const result = db.prepare(`UPDATE export_jobs SET cleanup_owner=?, cleanup_expires_at=?
      WHERE id=? AND status='completed' AND completed_at < ?
      AND (cleanup_expires_at IS NULL OR cleanup_expires_at <= ?)`)
      .run(owner, expiresAt, id, cutoff, claimedAt);
    return result.changes === 1 ? { id: row.id, format: row.format, outputPath: row.output_path } : null;
  });
}

export function assertExportPath(job: ExportJobRecord): string {
  if (job.status !== 'completed' || !job.outputPath) throw new Error('导出文件尚未生成');
  const expected = resolveManagedExportPath(job.id, job.format, job.outputPath);
  let stat: fsSync.Stats;
  try { stat = fsSync.lstatSync(expected); } catch { throw new Error('导出文件不存在'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('导出文件不是普通文件');
  try {
    if (fsSync.realpathSync(expected) !== expected) throw new Error('导出文件路径不是规范路径');
  } catch { throw new Error('导出文件路径无效'); }
  return expected;
}

function resolveManagedExportPath(id: string, format: ExportFormat, storedPath: string): string {
  if (!/^export-[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('导出任务 ID 无效');
  const extension = format === 'xlsx' ? 'xlsx' : 'csv';
  const basename = path.basename(storedPath);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const artifactPattern = new RegExp(`^${escapedId}\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extension}$`, 'i');
  if (!artifactPattern.test(basename)) throw new Error('导出路径无效');
  const root = path.resolve(exportRoot());
  const expected = path.resolve(root, basename);
  if (!expected.startsWith(`${root}${path.sep}`)) throw new Error('导出路径无效');
  if (path.isAbsolute(storedPath) && path.resolve(storedPath) !== expected) throw new Error('导出路径不属于受控目录');
  return expected;
}
