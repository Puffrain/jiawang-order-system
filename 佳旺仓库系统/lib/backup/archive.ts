import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import {
  type BackupManifest,
  type BackupManifestEntry,
  validateManifest,
} from './manifest';

const ARCHIVE_MAGIC = Buffer.from('JWARCH1\n', 'ascii');
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_COUNT = 100_000;

export interface ArchiveSource {
  path: string;
  sourcePath: string;
  kind: BackupManifestEntry['kind'];
}

export interface ArchiveBuildOptions {
  appVersion: string;
  schemaVersion: string;
  createdAt?: string;
}

export interface ExtractArchiveOptions {
  maxTotalBytes?: number;
  maxEntries?: number;
}

/**
 * A deliberately small, auditable container used inside the encrypted
 * .jwbackup envelope. It stores a manifest followed by length-delimited file
 * records. No filenames are interpreted until strict relative-path checks
 * have passed, so extraction cannot create symlinks or escape the staging
 * directory.
 */
export async function buildArchive(
  outputPath: string,
  sources: ArchiveSource[],
  options: ArchiveBuildOptions,
): Promise<BackupManifest> {
  if (!sources.length) throw new Error('备份内容不能为空');
  if (sources.length > MAX_ENTRY_COUNT) throw new Error('备份文件条目过多');

  const normalized = new Map<string, ArchiveSource>();
  for (const source of sources) {
    const relative = normalizeArchivePath(source.path);
    if (normalized.has(relative)) throw new Error(`备份路径重复：${relative}`);
    const stat = await fsp.lstat(source.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`备份源不是普通文件：${relative}`);
    normalized.set(relative, { ...source, path: relative });
  }

  const ordered = [...normalized.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const entries: BackupManifestEntry[] = [];
  for (const source of ordered) {
    const stat = await fsp.stat(source.sourcePath);
    entries.push({
      path: source.path,
      bytes: stat.size,
      sha256: await hashFile(source.sourcePath),
      kind: source.kind,
    });
  }
  const manifest: BackupManifest = {
    format: 'jwbackup',
    version: 1,
    appVersion: options.appVersion,
    schemaVersion: options.schemaVersion,
    createdAt: options.createdAt ?? new Date().toISOString(),
    entries,
  };
  if (!validateManifest(manifest)) throw new Error('生成的备份 manifest 无效');

  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('备份 manifest 过大');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  // Claim the destination with an exclusive open before attaching a stream;
  // createWriteStream emits EEXIST asynchronously and can otherwise become an
  // uncaught process error. The file is removed only when this call created it.
  const outputHandle = await fsp.open(outputPath, 'wx', 0o600);
  await outputHandle.close();
  const output = fs.createWriteStream(outputPath, { flags: 'r+', mode: 0o600 });
  try {
    await writeChunk(output, ARCHIVE_MAGIC);
    const manifestLength = Buffer.alloc(4);
    manifestLength.writeUInt32BE(manifestBytes.length, 0);
    await writeChunk(output, manifestLength);
    await writeChunk(output, manifestBytes);
    for (let index = 0; index < ordered.length; index += 1) {
      const source = ordered[index];
      const entry = entries[index];
      const name = Buffer.from(source.path, 'utf8');
      const header = Buffer.alloc(12);
      header.writeUInt32BE(name.length, 0);
      header.writeBigUInt64BE(BigInt(entry.bytes), 4);
      await writeChunk(output, header);
      await writeChunk(output, name);
      const input = fs.createReadStream(source.sourcePath);
      for await (const chunk of input) await writeChunk(output, Buffer.from(chunk));
    }
    output.end();
    await finished(output);
    const handle = await fsp.open(outputPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return manifest;
  } catch (error) {
    output.destroy();
    await fsp.rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readArchiveManifest(archivePath: string): Promise<BackupManifest> {
  const handle = await fsp.open(archivePath, 'r');
  try {
    const { manifest } = await readArchiveHeader(handle);
    return manifest;
  } finally {
    await handle.close();
  }
}

/** Extract and verify every entry into a new staging directory. */
export async function extractArchive(
  archivePath: string,
  destinationRoot: string,
  options: ExtractArchiveOptions = {},
): Promise<BackupManifest> {
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? MAX_ENTRY_COUNT;
  const root = path.resolve(destinationRoot);
  await fsp.mkdir(root, { recursive: false, mode: 0o700 });
  const handle = await fsp.open(archivePath, 'r');
  try {
    const { manifest, offset: firstEntryOffset } = await readArchiveHeader(handle);
    if (manifest.entries.length > maxEntries) throw new Error('备份条目数量超过恢复限制');
    const declaredTotal = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > maxTotalBytes) {
      throw new Error('备份展开大小超过恢复限制');
    }

    let offset = firstEntryOffset;
    for (const expected of manifest.entries) {
      const fixed = await readExact(handle, offset, 12);
      offset += fixed.length;
      const nameLength = fixed.readUInt32BE(0);
      const byteLength = Number(fixed.readBigUInt64BE(4));
      if (nameLength < 1 || nameLength > 4096 || !Number.isSafeInteger(byteLength)) {
        throw new Error('备份条目头无效');
      }
      const nameBytes = await readExact(handle, offset, nameLength);
      offset += nameLength;
      const name = normalizeArchivePath(new TextDecoder('utf-8', { fatal: true }).decode(nameBytes));
      if (name !== expected.path || byteLength !== expected.bytes) throw new Error('备份条目与 manifest 不一致');

      const target = safeTarget(root, name);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const output = await fsp.open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        let remaining = byteLength;
        let writeOffset = 0;
        const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, remaining)));
        while (remaining > 0) {
          const count = Math.min(buffer.length, remaining);
          const { bytesRead } = await handle.read(buffer, 0, count, offset);
          if (bytesRead !== count) throw new Error('备份包在文件内容结束前被截断');
          const slice = buffer.subarray(0, bytesRead);
          hash.update(slice);
          await output.write(slice, 0, bytesRead, writeOffset);
          offset += bytesRead;
          writeOffset += bytesRead;
          remaining -= bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
      if (hash.digest('hex') !== expected.sha256.toLowerCase()) throw new Error(`备份文件哈希不匹配：${name}`);
    }
    const archiveStat = await handle.stat();
    if (offset !== archiveStat.size) throw new Error('备份包包含未声明的尾随数据');
    return manifest;
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

export function normalizeArchivePath(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) {
    throw new Error('备份路径无效');
  }
  if (input.includes('\\') || input.includes(':') || input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.startsWith('//')) {
    throw new Error('备份路径必须是安全的相对路径');
  }
  const segments = input.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment) || /[ .]$/.test(segment) || isWindowsReservedName(segment))) {
    throw new Error('备份路径包含不安全片段');
  }
  return segments.join('/');
}

function isWindowsReservedName(value: string): boolean {
  const base = value.split('.')[0]?.toUpperCase();
  return Boolean(base && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base));
}

async function readArchiveHeader(handle: fsp.FileHandle): Promise<{ manifest: BackupManifest; offset: number }> {
  const prefix = await readExact(handle, 0, ARCHIVE_MAGIC.length + 4);
  if (!prefix.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) throw new Error('无效的佳旺备份归档');
  const manifestLength = prefix.readUInt32BE(ARCHIVE_MAGIC.length);
  if (manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES) throw new Error('备份 manifest 长度无效');
  const body = await readExact(handle, prefix.length, manifestLength);
  let manifest: unknown;
  try { manifest = JSON.parse(body.toString('utf8')); } catch { throw new Error('备份 manifest 不是有效 JSON'); }
  if (!validateManifest(manifest)) throw new Error('备份 manifest 校验失败');
  const typed = manifest as BackupManifest;
  const unique = new Set(typed.entries.map((entry) => normalizeArchivePath(entry.path)));
  if (unique.size !== typed.entries.length) throw new Error('备份 manifest 含重复路径');
  return { manifest: typed, offset: prefix.length + manifestLength };
}

async function readExact(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) throw new Error('备份包已截断');
    offset += result.bytesRead;
  }
  return buffer;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChunk(stream: fs.WriteStream, bytes: Buffer): Promise<void> {
  if (!stream.write(bytes)) await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onDrain = () => { cleanup(); resolve(); };
    const cleanup = () => { stream.off('error', onError); stream.off('drain', onDrain); };
    stream.once('error', onError);
    stream.once('drain', onDrain);
  });
}

function safeTarget(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(prefix)) throw new Error('备份路径越界');
  return target;
}
