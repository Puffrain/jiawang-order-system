import { apiOk, handleApiError } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { enqueueBackup, listBackups, listRestores } from '@/lib/backup/service';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson, ValidationError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List backup/restore jobs. Secrets, local paths and passphrases are never
 * returned; the service maps output paths to safe basenames only. */
export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'admin');
    const limit = Number(new URL(request.url).searchParams.get('limit') || 100);
    return apiOk({ backups: listBackups(limit), restores: listRestores(limit) }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

/** Queue an encrypted complete backup. The persistent worker performs the
 * potentially multi-gigabyte snapshot; this request only stores an
 * APP_MASTER_KEY-protected passphrase envelope. */
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const body = await parseJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('请求体必须是 JSON 对象');
    }
    const passphrase = (body as Record<string, unknown>).passphrase;
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 512) {
      throw new ValidationError('备份密码长度必须在 12-512 个字符之间', { passphrase: 'length' });
    }
    const backup = enqueueBackup(passphrase, actor.id);
    recordAudit({
      requestId,
      actorUserId: actor.id,
      action: 'backup.queued',
      resourceType: 'backup',
      resourceId: backup.id,
      metadata: { status: backup.status },
    });
    return apiOk({ backup }, requestId, 202);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
