import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import yauzl from "yauzl";
import { inspectImage, ImageInfo, ImageLimits } from "./image-inspect";

export interface ZipLimits extends ImageLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  /** Maximum uncompressed/compressed ratio. A ratio of 100 means 100:1. */
  maxCompressionRatio?: number;
  maxPathBytes?: number;
  rejectNestedArchives?: boolean;
  allowNonImages?: boolean;
}

export interface ExtractedZipEntry {
  name: string;
  path: string;
  bytes: number;
  image?: ImageInfo;
}

export interface ZipExtractionResult {
  root: string;
  entries: ExtractedZipEntry[];
  totalBytes: number;
  totalPixels: number;
}

export class ZipSecurityError extends Error {
  readonly code: string;
  readonly retryable = false;
  readonly class = "security" as const;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ZipSecurityError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULTS: Required<Pick<ZipLimits, "maxEntries" | "maxEntryBytes" | "maxTotalBytes" | "maxCompressionRatio" | "maxPathBytes" | "rejectNestedArchives" | "allowNonImages">> = {
  maxEntries: 10_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxPathBytes: 512,
  rejectNestedArchives: true,
  allowNonImages: false,
};
type NormalizedZipLimits = typeof DEFAULTS & ImageLimits;

/**
 * Parse and extract a ZIP from bytes. The parser intentionally does not shell
 * out to `unzip`: every central-directory field is checked before any output
 * is written, and extraction paths are generated under a private root.
 */
export async function extractSafeZip(input: Uint8Array, destinationRoot: string, limits: ZipLimits = {}): Promise<ZipExtractionResult> {
  const opts: NormalizedZipLimits = { ...DEFAULTS, ...limits };
  const bytes = Buffer.from(input);
  const eocd = findEndOfCentralDirectory(bytes);
  const count = eocd.entries;
  if (count > opts.maxEntries) throw new ZipSecurityError("ZIP_ENTRY_LIMIT", `ZIP contains ${count} entries; limit is ${opts.maxEntries}`);
  if (eocd.centralOffset + eocd.centralSize > bytes.length) throw new ZipSecurityError("ZIP_DIRECTORY_RANGE", "ZIP central directory is outside the file");
  const entries = parseCentralDirectory(bytes, eocd, opts);
  const parentRoot = path.resolve(destinationRoot);
  const parentStat = await fs.lstat(parentRoot).catch(() => undefined);
  if (parentStat?.isSymbolicLink()) throw new ZipSecurityError("ZIP_ROOT_SYMLINK", "Extraction destination cannot be a symlink");
  const root = path.resolve(parentRoot, `extract-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const output: ExtractedZipEntry[] = [];
  let totalBytes = 0;
  let totalPixels = 0;
  try {
    for (const entry of entries) {
      if (entry.directory) {
        const dir = safeResolve(root, entry.name, opts.maxPathBytes);
        await ensureNoSymlinkPath(root, dir);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        continue;
      }
      const data = inflateEntry(bytes, entry, opts);
      totalBytes += data.length;
      if (totalBytes > opts.maxTotalBytes) throw new ZipSecurityError("ZIP_TOTAL_BYTES", `ZIP expands beyond ${opts.maxTotalBytes} bytes`);
      if (opts.rejectNestedArchives && looksLikeArchive(entry.name, data)) throw new ZipSecurityError("ZIP_NESTED_ARCHIVE", `Nested archive is not allowed: ${entry.name}`);
      let image: ImageInfo | undefined;
      try {
        image = inspectImage(data, opts);
        totalPixels += image.pixels;
        if (opts.maxPixels !== undefined && totalPixels > opts.maxPixels) throw new ZipSecurityError("ZIP_PIXEL_LIMIT", `ZIP images exceed ${opts.maxPixels} pixels`);
      } catch (error) {
        if (!opts.allowNonImages) {
          if (error instanceof ZipSecurityError) throw error;
          throw new ZipSecurityError("ZIP_NON_IMAGE", `Unsupported image entry: ${entry.name}`);
        }
      }
      const target = safeResolve(root, entry.name, opts.maxPathBytes);
      await ensureNoSymlinkPath(root, target);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      // `wx` prevents replacement of an already-created path (including a
      // symlink) if a caller accidentally reuses a destination root.
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      output.push({ name: entry.name, path: target, bytes: data.length, image });
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { root, entries: output, totalBytes, totalPixels };
}

/**
 * File-backed variant used by the production worker. It parses the central
 * directory with yauzl and streams one entry at a time to an isolated
 * staging directory, so a multi-gigabyte archive is never copied into the
 * Node heap. The byte-oriented function above remains available for small
 * unit fixtures and callers that already hold a bounded buffer.
 */
export async function extractSafeZipFile(inputPath: string, destinationRoot: string, limits: ZipLimits = {}): Promise<ZipExtractionResult> {
  const stat = await fs.lstat(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ZipSecurityError("ZIP_SOURCE", "ZIP source must be a regular local file");
  const real = await fs.realpath(inputPath);
  if (real !== path.resolve(inputPath)) throw new ZipSecurityError("ZIP_SOURCE", "ZIP source must not be a symlink");
  const opts: NormalizedZipLimits = { ...DEFAULTS, ...limits };
  const zip = await openZipFile(inputPath, opts.maxEntries);
  const parentRoot = path.resolve(destinationRoot);
  const parentStat = await fs.lstat(parentRoot).catch(() => undefined);
  if (parentStat?.isSymbolicLink()) { zip.close(); throw new ZipSecurityError("ZIP_ROOT_SYMLINK", "Extraction destination cannot be a symlink"); }
  const root = path.resolve(parentRoot, `extract-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const output: ExtractedZipEntry[] = [];
  let totalBytes = 0;
  let totalPixels = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* best effort */ }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.once('error', fail);
      zip.once('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', (entry) => {
        void handleStreamedEntry(zip, entry, root, opts, (record, bytes, pixels) => {
          if (totalBytes + bytes > opts.maxTotalBytes) throw new ZipSecurityError("ZIP_TOTAL_BYTES", `ZIP expands beyond ${opts.maxTotalBytes} bytes`);
          if (opts.maxPixels !== undefined && totalPixels + pixels > opts.maxPixels) throw new ZipSecurityError("ZIP_PIXEL_LIMIT", `ZIP images exceed ${opts.maxPixels} pixels`);
          output.push(record);
          totalBytes += bytes;
          totalPixels += pixels;
        }).then(() => {
          if (!settled) zip.readEntry();
        }).catch(fail);
      });
      zip.readEntry();
    });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    try { zip.close(); } catch { /* already closed */ }
  }
  return { root, entries: output, totalBytes, totalPixels };
}

function openZipFile(inputPath: string, maxEntries: number): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(inputPath, { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new ZipSecurityError("ZIP_OPEN", error?.message || "Unable to open ZIP")); return; }
      if (zip.entryCount > maxEntries) { zip.close(); reject(new ZipSecurityError("ZIP_ENTRY_LIMIT", `ZIP contains ${zip.entryCount} entries; limit is ${maxEntries}`)); return; }
      resolve(zip);
    });
  });
}

async function handleStreamedEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  root: string,
  opts: NormalizedZipLimits,
  onAccepted: (record: ExtractedZipEntry, bytes: number, pixels: number) => void,
): Promise<void> {
  const name = entry.fileName;
  validateEntryName(name, opts.maxPathBytes);
  if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x1) !== 0) throw new ZipSecurityError("ZIP_ENCRYPTED", `Encrypted ZIP entry is not accepted: ${name}`);
  if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)) throw new ZipSecurityError("ZIP64_UNSUPPORTED", `ZIP64 entry is not accepted: ${name}`);
  if (entry.uncompressedSize > opts.maxEntryBytes) throw new ZipSecurityError("ZIP_ENTRY_BYTES", `Entry ${name} expands beyond the per-entry limit`);
  if (entry.uncompressedSize > 0 && entry.compressedSize === 0) throw new ZipSecurityError("ZIP_RATIO", `Entry ${name} has an invalid compression ratio`);
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > opts.maxCompressionRatio) throw new ZipSecurityError("ZIP_RATIO", `Entry ${name} exceeds the compression-ratio limit`);
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((unixMode & 0xf000) === 0xa000) throw new ZipSecurityError("ZIP_SYMLINK", `Symlink entry is not accepted: ${name}`);
  const target = safeResolve(root, name, opts.maxPathBytes);
  if (name.endsWith('/')) {
    await ensureNoSymlinkPath(root, target);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  await ensureNoSymlinkPath(root, target);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomUUID()}.part`;
  let bytes = 0;
  try {
    const stream = await openEntryStream(zip, entry);
    const output = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    try {
      for await (const chunk of stream) {
        const data = Buffer.from(chunk as Uint8Array);
        bytes += data.length;
        if (bytes > opts.maxEntryBytes) throw new ZipSecurityError("ZIP_ENTRY_BYTES", `Entry ${name} expands beyond the per-entry limit`);
        if (!output.write(data)) await onceDrain(output);
      }
      output.end();
      await finished(output);
    } finally {
      output.destroy();
    }
    if (bytes !== entry.uncompressedSize) throw new ZipSecurityError("ZIP_SIZE_MISMATCH", `Uncompressed size mismatch for ${name}`);
    totalGuard(opts, bytes);
    const data = await fs.readFile(temp);
    // yauzl validates entry sizes but intentionally leaves CRC verification to
    // callers. Check the central-directory checksum before image parsing so a
    // corrupted payload can never be promoted as a valid asset.
    if (crc32(data) !== entry.crc32) throw new ZipSecurityError("ZIP_CRC", `CRC mismatch for ${name}`);
    if (opts.rejectNestedArchives && looksLikeArchive(name, data)) throw new ZipSecurityError("ZIP_NESTED_ARCHIVE", `Nested archive is not allowed: ${name}`);
    let image: ImageInfo | undefined;
    let pixels = 0;
    try {
      image = inspectImage(data, opts);
      pixels = image.pixels;
      if (opts.maxPixels !== undefined && pixels > opts.maxPixels) throw new ZipSecurityError("ZIP_PIXEL_LIMIT", `ZIP images exceed ${opts.maxPixels} pixels`);
    } catch (error) {
      if (!opts.allowNonImages) {
        if (error instanceof ZipSecurityError) throw error;
        throw new ZipSecurityError("ZIP_NON_IMAGE", `Unsupported image entry: ${name}`);
      }
    }
    await fs.rename(temp, target);
    onAccepted({ name, path: target, bytes, image }, bytes, pixels);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error || new Error('Unable to open ZIP entry')) : resolve(stream)));
}

function onceDrain(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { stream.off('drain', onDrain); stream.off('error', onError); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function totalGuard(opts: NormalizedZipLimits, bytes: number): void {
  // The aggregate counter is enforced in the caller after each accepted
  // entry; this local check catches impossible per-entry values early.
  if (bytes > opts.maxTotalBytes) throw new ZipSecurityError("ZIP_TOTAL_BYTES", `ZIP expands beyond ${opts.maxTotalBytes} bytes`);
}

interface CentralEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
  localOffset: number;
  crc: number;
  directory: boolean;
  symlink: boolean;
}

interface EndRecord {
  entries: number;
  centralSize: number;
  centralOffset: number;
}

function findEndOfCentralDirectory(bytes: Buffer): EndRecord {
  const min = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue;
    const disk = bytes.readUInt16LE(i + 4);
    const centralDisk = bytes.readUInt16LE(i + 6);
    const entriesDisk = bytes.readUInt16LE(i + 8);
    const entries = bytes.readUInt16LE(i + 10);
    const centralSize = bytes.readUInt32LE(i + 12);
    const centralOffset = bytes.readUInt32LE(i + 16);
    const commentLength = bytes.readUInt16LE(i + 20);
    if (i + 22 + commentLength > bytes.length) continue;
    if (disk !== 0 || centralDisk !== 0 || entriesDisk !== entries) throw new ZipSecurityError("ZIP_MULTIDISK", "Multi-disk ZIP archives are not supported");
    if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new ZipSecurityError("ZIP64_UNSUPPORTED", "ZIP64 archives are not supported by the safe extractor");
    return { entries, centralSize, centralOffset };
  }
  throw new ZipSecurityError("ZIP_EOCD_MISSING", "ZIP end-of-central-directory record is missing");
}

function parseCentralDirectory(bytes: Buffer, end: EndRecord, limits: NormalizedZipLimits): CentralEntry[] {
  const result: CentralEntry[] = [];
  let offset = end.centralOffset;
  for (let index = 0; index < end.entries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new ZipSecurityError("ZIP_DIRECTORY_ENTRY", "Malformed ZIP central directory");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttrs = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const endOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (endOffset > bytes.length) throw new ZipSecurityError("ZIP_DIRECTORY_RANGE", "ZIP central directory entry is truncated");
    if (flags & 0x1) throw new ZipSecurityError("ZIP_ENCRYPTED", "Encrypted ZIP entries are not accepted");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipSecurityError("ZIP64_UNSUPPORTED", "ZIP64 entry is not accepted");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(rawName, Boolean(flags & 0x800));
    validateEntryName(name, limits.maxPathBytes);
    const directory = name.endsWith("/") || (externalAttrs & 0x10) !== 0;
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const symlink = (unixMode & 0xf000) === 0xa000;
    if (symlink) throw new ZipSecurityError("ZIP_SYMLINK", `Symlink entry is not accepted: ${name}`);
    if (uncompressedSize > limits.maxEntryBytes) throw new ZipSecurityError("ZIP_ENTRY_BYTES", `Entry ${name} expands beyond the per-entry limit`);
    if (uncompressedSize > 0 && compressedSize === 0) throw new ZipSecurityError("ZIP_RATIO", `Entry ${name} has an invalid compression ratio`);
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) throw new ZipSecurityError("ZIP_RATIO", `Entry ${name} exceeds the compression-ratio limit`);
    if (method !== 0 && method !== 8) throw new ZipSecurityError("ZIP_METHOD", `Compression method ${method} is not supported`);
    result.push({ name, compressedSize, uncompressedSize, method, flags, localOffset, crc, directory, symlink });
    offset = endOffset;
  }
  return result;
}

function inflateEntry(bytes: Buffer, entry: CentralEntry, limits: NormalizedZipLimits): Buffer {
  const o = entry.localOffset;
  if (o + 30 > bytes.length || bytes.readUInt32LE(o) !== 0x04034b50) throw new ZipSecurityError("ZIP_LOCAL_HEADER", `Malformed local header for ${entry.name}`);
  const nameLength = bytes.readUInt16LE(o + 26);
  const extraLength = bytes.readUInt16LE(o + 28);
  const start = o + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < o || end > bytes.length) throw new ZipSecurityError("ZIP_DATA_RANGE", `Entry data is outside the archive: ${entry.name}`);
  const compressed = bytes.subarray(start, end);
  let output: Buffer;
  try {
    if (entry.method === 0) output = Buffer.from(compressed);
    else output = zlib.inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes });
  } catch (error) {
    throw new ZipSecurityError("ZIP_DEFLATE", `Unable to safely decompress ${entry.name}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (output.length !== entry.uncompressedSize) throw new ZipSecurityError("ZIP_SIZE_MISMATCH", `Uncompressed size mismatch for ${entry.name}`);
  if (output.length > limits.maxEntryBytes) throw new ZipSecurityError("ZIP_ENTRY_BYTES", `Entry ${entry.name} expands beyond the per-entry limit`);
  if (compressed.length > 0 && output.length / compressed.length > limits.maxCompressionRatio) throw new ZipSecurityError("ZIP_RATIO", `Entry ${entry.name} exceeds the actual compression-ratio limit`);
  if (crc32(output) !== entry.crc) throw new ZipSecurityError("ZIP_CRC", `CRC mismatch for ${entry.name}`);
  return output;
}

function decodeName(value: Uint8Array, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw new ZipSecurityError("ZIP_NAME_ENCODING", "ZIP filename is not valid UTF-8");
    }
  }
  // CP437 is the ZIP default. ASCII is a strict subset and covers normal
  // uploads; replacing non-ASCII bytes avoids interpreting them as path chars.
  return Array.from(value, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : "_")).join("");
}

function validateEntryName(name: string, maxPathBytes: number): void {
  if (!name || Buffer.byteLength(name, "utf8") > maxPathBytes) throw new ZipSecurityError("ZIP_PATH", "ZIP entry path is empty or too long");
  if (name.includes("\0") || /[\u0000-\u001f\u007f]/.test(name)) throw new ZipSecurityError("ZIP_PATH", "ZIP entry path contains control characters");
  if (name.includes(':')) throw new ZipSecurityError("ZIP_PATH_ADS", "NTFS alternate data streams are not accepted");
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith("//") || name.startsWith("\\\\")) throw new ZipSecurityError("ZIP_PATH_ABSOLUTE", `Absolute/UNC ZIP path is not accepted: ${name}`);
  const normalized = name.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) throw new ZipSecurityError("ZIP_PATH_TRAVERSAL", `Path traversal is not accepted: ${name}`);
  if (/^[a-zA-Z]:$/.test(normalized.split("/")[0])) throw new ZipSecurityError("ZIP_PATH_ABSOLUTE", `Drive-qualified ZIP path is not accepted: ${name}`);
  for (const segment of normalized.split('/')) {
    if (!segment) continue;
    if (/[ .]$/.test(segment) || isWindowsReservedName(segment)) throw new ZipSecurityError("ZIP_PATH_RESERVED", `Windows reserved filename is not accepted: ${name}`);
  }
}

function isWindowsReservedName(value: string): boolean {
  const base = value.split('.')[0]?.toUpperCase();
  return Boolean(base && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base));
}

function safeResolve(root: string, name: string, maxPathBytes: number): string {
  validateEntryName(name, maxPathBytes);
  const relative = name.replace(/\\/g, "/");
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new ZipSecurityError("ZIP_PATH_TRAVERSAL", `Resolved path escapes extraction root: ${name}`);
  return target;
}

async function ensureNoSymlinkPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new ZipSecurityError("ZIP_SYMLINK", `Extraction path contains a symlink: ${segment}`);
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function looksLikeArchive(name: string, data: Buffer): boolean {
  const ext = path.extname(name).toLowerCase();
  if ([".zip", ".jar", ".apk", ".war", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"].includes(ext)) return true;
  return data.length >= 4 && (data.readUInt32LE(0) === 0x04034b50 || data.readUInt32LE(0) === 0x06054b50 || data.subarray(0, 6).toString("ascii") === "7z\xbc\xaf'\x1c" || data.subarray(0, 2).toString("ascii") === "\x1f\x8b");
}

// Standard CRC-32 (IEEE). Kept local to avoid a native dependency.
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
