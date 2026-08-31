import fs from 'node:fs/promises';

export interface RestoreMultipartResult {
  passphrase: string;
  bytes: number;
}

/**
 * Stream the two supported restore fields (`file` and `passphrase`) without
 * relying on Request.formData(). The latter is allowed to buffer a complete
 * Blob before the application can enforce its size limit. This small parser
 * keeps only multipart headers and a boundary-sized tail in memory while the
 * encrypted package is written to a server-created file.
 */
export async function streamRestoreMultipart(
  request: Request,
  target: string,
  maxFileBytes: number,
): Promise<RestoreMultipartResult> {
  const contentType = request.headers.get('content-type') || '';
  const boundary = parseBoundary(contentType);
  const body = request.body;
  if (!body) throw multipartError('RESTORE_BODY', '恢复请求没有可读取的 body', 400);
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw multipartError('RESTORE_CONFIG', '恢复大小限制无效', 500);

  const handle = await fs.open(target, 'wx', 0o600);
  const reader = body.getReader();
  const opening = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let buffer = Buffer.alloc(0);
  let state: 'preamble' | 'headers' | 'data' | 'done' = 'preamble';
  let field: 'file' | 'passphrase' | undefined;
  let seenFile = false;
  let seenPassphrase = false;
  let fileBytes = 0;
  let passphraseBytes = 0;
  const passphraseChunks: Buffer[] = [];
  let failed = true;

  const append = (chunk: Uint8Array) => {
    if (!chunk.byteLength) return;
    buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(chunk)]) : Buffer.from(chunk);
  };

  const consume = async (count: number) => {
    if (count <= 0) return;
    const chunk = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    if (field === 'file') {
      fileBytes += chunk.length;
      if (fileBytes > maxFileBytes) throw multipartError('RESTORE_SIZE', '恢复包超过大小限制', 413);
      await handle.write(chunk);
    } else if (field === 'passphrase') {
      passphraseBytes += chunk.length;
      // A 512-character UTF-8 passphrase is well below this byte ceiling;
      // reject pathological field bodies before accumulating them.
      if (passphraseBytes > 4096) throw multipartError('RESTORE_PASSPHRASE', '恢复密码字段过大', 400);
      passphraseChunks.push(Buffer.from(chunk));
    }
  };

  const readMore = async (): Promise<boolean> => {
    const next = await reader.read();
    if (next.done) return false;
    append(next.value);
    return true;
  };

  try {
    while (state !== 'done') {
      if (state === 'preamble') {
        const start = buffer.indexOf(opening);
        if (start < 0) {
          if (buffer.length > opening.length + 8) throw multipartError('RESTORE_MULTIPART', 'multipart 起始边界无效', 400);
          if (!(await readMore())) throw multipartError('RESTORE_MULTIPART', 'multipart 起始边界缺失', 400);
          continue;
        }
        buffer = buffer.subarray(start + opening.length);
        while (buffer.length < 2) {
          if (!(await readMore())) throw multipartError('RESTORE_MULTIPART', 'multipart 起始边界不完整', 400);
        }
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) throw multipartError('RESTORE_MULTIPART', 'multipart 中没有文件字段', 400);
        if (!buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) throw multipartError('RESTORE_MULTIPART', 'multipart 起始边界格式无效', 400);
        buffer = buffer.subarray(2);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        const end = buffer.indexOf(Buffer.from('\r\n\r\n'));
        if (end < 0) {
          if (buffer.length > 16 * 1024) throw multipartError('RESTORE_MULTIPART', 'multipart 头部过大', 400);
          if (!(await readMore())) throw multipartError('RESTORE_MULTIPART', 'multipart 头部不完整', 400);
          continue;
        }
        const headerText = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const parsed = parsePartHeaders(headerText);
        if (parsed.name === 'file' && parsed.filename !== undefined) {
          if (seenFile) throw multipartError('RESTORE_MULTIPART', '恢复请求包含多个文件字段', 400);
          seenFile = true;
          field = 'file';
        } else if (parsed.name === 'passphrase' && parsed.filename === undefined) {
          if (seenPassphrase) throw multipartError('RESTORE_MULTIPART', '恢复请求包含多个密码字段', 400);
          seenPassphrase = true;
          field = 'passphrase';
        } else {
          throw multipartError('RESTORE_MULTIPART', '仅支持 file 和 passphrase 字段', 400);
        }
        state = 'data';
        continue;
      }

      if (state === 'data') {
        const boundaryIndex = findValidDelimiter(buffer, delimiter);
        if (boundaryIndex < 0) {
          // Keep enough bytes for a delimiter split across network chunks.
          const keep = delimiter.length + 4;
          const writable = Math.max(0, buffer.length - keep);
          if (writable) await consume(writable);
          if (!(await readMore())) throw multipartError('RESTORE_MULTIPART', 'multipart 结束边界缺失', 400);
          continue;
        }
        await consume(boundaryIndex);
        // consume() removes the bytes before the delimiter, so the current
        // buffer starts at the delimiter itself.
        buffer = buffer.subarray(delimiter.length);
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) {
          buffer = buffer.subarray(2);
          state = 'done';
        } else if (buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) {
          buffer = buffer.subarray(2);
          field = undefined;
          state = 'headers';
        } else {
          throw multipartError('RESTORE_MULTIPART', 'multipart 结束边界格式无效', 400);
        }
        continue;
      }
    }

    // Drain the optional trailing CRLF when it was split across chunks. Do
    // not accept a second payload after the final boundary.
    while (buffer.length <= 2 && await readMore()) {
      if (buffer.length > 2) break;
    }
    // RFC 7578 permits a trailing CRLF after the final boundary.
    if (buffer.length && buffer.equals(Buffer.from('\r\n'))) buffer = Buffer.alloc(0);
    if (buffer.length) throw multipartError('RESTORE_MULTIPART', 'multipart 结束边界后存在多余数据', 400);
    await handle.sync();
    if (!seenFile || fileBytes <= 0) throw multipartError('RESTORE_SIZE', '恢复文件字段为空', 413);
    if (!seenPassphrase) throw multipartError('RESTORE_PASSPHRASE', '缺少恢复密码字段', 400);
    const passphrase = Buffer.concat(passphraseChunks).toString('utf8');
    if (passphrase.length < 12 || passphrase.length > 512) throw multipartError('RESTORE_PASSPHRASE', '恢复密码长度必须在 12-512 个字符之间', 400);
    failed = false;
    return { passphrase, bytes: fileBytes };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await handle.close().catch(() => undefined);
    if (failed) await fs.rm(target, { force: true }).catch(() => undefined);
  }
}

function parseBoundary(contentType: string): string {
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw multipartError('UNSUPPORTED_MEDIA_TYPE', '恢复请求必须使用 multipart/form-data', 415);
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary || boundary.length > 200 || /[\u0000-\u001f\u007f]/.test(boundary)) throw multipartError('RESTORE_MULTIPART', 'multipart boundary 无效', 400);
  return boundary;
}

function parsePartHeaders(text: string): { name: string; filename?: string } {
  const disposition = text.split(/\r\n/).find((line) => /^content-disposition\s*:/i.test(line));
  const match = /content-disposition\s*:\s*form-data\s*;\s*name="([^"]{1,64})"(?:\s*;\s*filename="([^"]*)")?/i.exec(disposition || '');
  if (!match) throw multipartError('RESTORE_MULTIPART', 'multipart 字段头部无效', 400);
  return { name: match[1], ...(match[2] !== undefined ? { filename: match[2] } : {}) };
}

function findValidDelimiter(buffer: Buffer, delimiter: Buffer): number {
  let offset = 0;
  while (offset < buffer.length) {
    const index = buffer.indexOf(delimiter, offset);
    if (index < 0) return -1;
    const suffix = buffer.subarray(index + delimiter.length, index + delimiter.length + 2);
    if (suffix.equals(Buffer.from('--')) || suffix.equals(Buffer.from('\r\n'))) return index;
    offset = index + 1;
  }
  return -1;
}

function multipartError(code: string, message: string, status: number): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = code;
  error.status = status;
  return error;
}
