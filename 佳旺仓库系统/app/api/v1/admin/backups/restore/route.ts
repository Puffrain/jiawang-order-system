import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { apiOk, handleApiError } from '@/lib/api';
import { backupInputRoot, enqueueRestore } from '@/lib/backup/service';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { streamRestoreMultipart } from '@/lib/backup/multipart';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RESTORE_UPLOAD_BYTES = parseLimit('RESTORE_MAX_BYTES', 64 * 1024 * 1024 * 1024);

/** Accept a multipart restore package into an isolated server-side staging
 * directory. The worker decrypts and validates it asynchronously; this route
 * never opens or switches the live database. */
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  let retained: string | undefined;
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    const actor = requireSessionUser(request, 'admin');
    const lengthHeader = request.headers.get('content-length');
    const length = lengthHeader == null ? undefined : Number(lengthHeader);
    if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0)) {
      throw Object.assign(new Error('恢复请求 Content-Length 无效'), { code: 'BODY_LENGTH', status: 400 });
    }
    if (length !== undefined && length > MAX_RESTORE_UPLOAD_BYTES + 1024 * 1024) {
      throw Object.assign(new Error('恢复包过大'), { code: 'BODY_LIMIT', status: 413 });
    }
    const contentType = request.headers.get('content-type') || '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
      throw Object.assign(new Error('恢复请求必须使用 multipart/form-data'), { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    }
    const root = await backupInputRoot();
    // Keep the actual copy under the service-controlled incoming root. The
    // enqueue helper performs an exclusive copy and stores only an encrypted
    // passphrase in SQLite.
    retained = `${root}/.http-${process.pid}-${randomUUID()}.jwbackup`;
    const upload = await streamRestoreMultipart(request, retained, MAX_RESTORE_UPLOAD_BYTES);
    const restore = await enqueueRestore(retained, upload.passphrase, actor.id);
    // enqueueRestore copies into its own managed path; remove the HTTP
    // staging file immediately so a crashed request cannot leave plaintext
    // temporary data behind.
    await fs.rm(retained, { force: true });
    retained = undefined;
    recordAudit({ requestId, actorUserId: actor.id, action: 'restore.queued', resourceType: 'restore', resourceId: restore.id, metadata: { bytes: upload.bytes } });
    return apiOk({ restore }, requestId, 202);
  } catch (error) {
    if (retained) await fs.rm(retained, { force: true }).catch(() => undefined);
    return handleApiError(error, requestId);
  }
}

function parseLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
