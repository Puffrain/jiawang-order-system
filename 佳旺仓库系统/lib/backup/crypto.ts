import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('JWBACKUP1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface BackupEnvelopeHeader {
  version: 1;
  algorithm: 'aes-256-gcm+scrypt';
  salt: string;
  iv: string;
  tag: string;
  payloadBytes: number;
}

function encodeHeader(header: BackupEnvelopeHeader): Buffer {
  const body = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([MAGIC, length, body]);
}

function decodeHeader(input: Buffer): { header: BackupEnvelopeHeader; offset: number } {
  if (input.subarray(0, MAGIC.length).compare(MAGIC) !== 0) throw new Error('无效的佳旺备份格式');
  const lengthOffset = MAGIC.length;
  if (input.length < MAGIC.length + 4) throw new Error('备份包头不完整');
  const bodyLength = input.readUInt32BE(lengthOffset);
  if (bodyLength < 2 || bodyLength > 1024 * 1024) throw new Error('备份包头长度无效');
  const start = lengthOffset + 4;
  const end = start + bodyLength;
  if (end > input.length) throw new Error('备份包头不完整');
  const parsed = JSON.parse(input.subarray(start, end).toString('utf8')) as Partial<BackupEnvelopeHeader>;
  if (parsed.version !== 1 || parsed.algorithm !== 'aes-256-gcm+scrypt') throw new Error('不支持的备份版本');
  return { header: parsed as BackupEnvelopeHeader, offset: end };
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (!password || password.length < 12) throw new Error('备份密码至少需要 12 个字符');
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

/** Stream a large plaintext archive into an encrypted .jwbackup file. The
 * small encryptBackup API below remains useful for unit tests; this variant
 * keeps multi-gigabyte media out of the Node heap. */
export async function encryptBackupFile(inputPath: string, outputPath: string, password: string): Promise<BackupEnvelopeHeader> {
  const inputStat = await fsp.stat(inputPath);
  if (!inputStat.isFile() || !Number.isSafeInteger(inputStat.size)) throw new Error('备份归档不存在');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const cipherPath = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.cipher`;
  const envelopeTempPath = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.part`;
  await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    await pipeline(fs.createReadStream(inputPath), cipher, fs.createWriteStream(cipherPath, { flags: 'wx', mode: 0o600 }));
    const cipherStat = await fsp.stat(cipherPath);
    const header: BackupEnvelopeHeader = {
      version: 1,
      algorithm: 'aes-256-gcm+scrypt',
      salt: salt.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      payloadBytes: cipherStat.size,
    };
    const out = fs.createWriteStream(envelopeTempPath, { flags: 'wx', mode: 0o600 });
    try {
      if (!out.write(encodeHeader(header))) await onceDrain(out);
      await pipeline(fs.createReadStream(cipherPath), out);
    } catch (error) {
      out.destroy();
      throw error;
    }
    await commitExclusive(envelopeTempPath, outputPath);
    return header;
  } finally {
    await fsp.rm(cipherPath, { force: true }).catch(() => undefined);
    await fsp.rm(envelopeTempPath, { force: true }).catch(() => undefined);
  }
}

/** Decrypt a streaming envelope to a temporary plaintext archive. GCM
 * authentication is checked when the stream finishes; a failed tag removes
 * the partial output. */
export async function decryptBackupFile(envelopePath: string, outputPath: string, password: string, maxPayloadBytes = 64 * 1024 * 1024 * 1024): Promise<BackupEnvelopeHeader> {
  const stat = await fsp.stat(envelopePath);
  if (!stat.isFile() || stat.size < MAGIC.length + 4) throw new Error('备份包不存在或不完整');
  const prefix = await readAtMost(envelopePath, MAGIC.length + 4);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('无效的佳旺备份格式');
  const bodyLength = prefix.readUInt32BE(MAGIC.length);
  if (bodyLength < 2 || bodyLength > 1024 * 1024) throw new Error('备份包头长度无效');
  const headerBytes = await readAtMost(envelopePath, MAGIC.length + 4 + bodyLength);
  const { header, offset } = decodeHeader(headerBytes);
  if (!Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0 || header.payloadBytes > maxPayloadBytes || stat.size - offset !== header.payloadBytes) {
    throw new Error('备份包长度校验失败');
  }
  const salt = Buffer.from(header.salt, 'base64url');
  const iv = Buffer.from(header.iv, 'base64url');
  const tag = Buffer.from(header.tag, 'base64url');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('备份包加密头无效');
  const key = await deriveKey(password, salt);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintextTempPath = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.part`;
  try {
    await pipeline(
      fs.createReadStream(envelopePath, { start: offset, end: stat.size - 1 }),
      decipher,
      fs.createWriteStream(plaintextTempPath, { flags: 'wx', mode: 0o600 }),
    );
    await commitExclusive(plaintextTempPath, outputPath);
    return header;
  } catch {
    throw new Error('备份密码错误或备份包已损坏');
  } finally {
    await fsp.rm(plaintextTempPath, { force: true }).catch(() => undefined);
  }
}

/** Encrypt an archive payload. The password is never persisted in the envelope. */
export async function encryptBackup(payload: Uint8Array, password: string): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header: BackupEnvelopeHeader = {
    version: 1,
    algorithm: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    payloadBytes: encrypted.length,
  };
  return Buffer.concat([encodeHeader(header), encrypted]);
}

export async function decryptBackup(envelope: Uint8Array, password: string): Promise<Buffer> {
  const input = Buffer.from(envelope);
  const { header, offset } = decodeHeader(input);
  const encrypted = input.subarray(offset);
  if (encrypted.length !== header.payloadBytes) throw new Error('备份包长度校验失败');
  const salt = Buffer.from(header.salt, 'base64url');
  const iv = Buffer.from(header.iv, 'base64url');
  const tag = Buffer.from(header.tag, 'base64url');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('备份包加密头无效');
  const key = await deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('备份密码错误或备份包已损坏');
  }
}

function onceDrain(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { stream.off('drain', onDrain); stream.off('error', onError); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function readAtMost(filePath: string, length: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Publish a newly-created temporary file without overwriting an existing
 * operator file. Hard-link creation is atomic on the same volume; the stream
 * fallback still opens the destination with `wx` and therefore has the same
 * no-clobber property. */
async function commitExclusive(tempPath: string, outputPath: string): Promise<void> {
  try {
    await fsp.link(tempPath, outputPath);
    await fsp.rm(tempPath, { force: true });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    // Some filesystems do not support hard links for a named volume. Create
    // the destination exclusively, then stream-copy and clean only that file
    // if this operation owns it.
    let created = false;
    try {
      const handle = await fsp.open(outputPath, 'wx', 0o600);
      await handle.close();
      created = true;
      await pipeline(fs.createReadStream(tempPath), fs.createWriteStream(outputPath, { flags: 'r+' }));
      await fsp.rm(tempPath, { force: true });
    } catch (fallbackError) {
      if (created) await fsp.rm(outputPath, { force: true }).catch(() => undefined);
      throw fallbackError;
    }
  }
}
