import fs from 'node:fs/promises';
import path from 'node:path';
import { apiError, apiOk, handleApiError } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { getMaintenanceState, clearMaintenanceMode } from '@/lib/maintenance';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Expose a deliberately redacted operational view. The owner token and
 * filesystem paths are not returned to the browser. */
export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'admin');
    const state = getMaintenanceState();
    const journal = await readJournalSummary();
    return apiOk({
      maintenance: {
        active: state.active,
        reason: state.reason,
        changedAt: state.changedAt,
        leaseExpiresAt: state.leaseExpiresAt,
        manualRecoveryRequired: state.manualRecoveryRequired,
      },
      journal,
    }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

/** Force-clearing a fence is intentionally explicit and audited. An active
 * restore journal is refused by default because clearing it could reopen a
 * split-brain database; an operator must first finish/clean the journal via
 * the recovery worker or an out-of-band runbook. */
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    // This is the one deliberately narrow maintenance exception: an already
    // authenticated administrator must be able to inspect/force-clear a
    // crashed fence after the journal check. No normal data write is allowed
    // through this bypass.
    const actor = requireSessionUser(request, 'admin', { allowMaintenance: true });
    const body = await parseJson(request) as Record<string, unknown>;
    if (body.action !== 'force_clear') return apiError('ACTION_INVALID', '仅支持 force_clear 操作', requestId, 400);
    if (body.confirmation !== '确认清理维护锁') return apiError('CONFIRMATION_REQUIRED', '请输入“确认清理维护锁”', requestId, 400);
    const journal = await readJournalSummary();
    if (journal.exists) return apiError('RESTORE_JOURNAL_ACTIVE', '恢复 journal 仍存在，请先完成或人工核对恢复', requestId, 409, journal);
    const before = getMaintenanceState();
    if (!before.active) return apiOk({ cleared: false, maintenance: before }, requestId);
    // The owner is intentionally read from the durable row and never accepted
    // from the request body. `force=true` is safe only after the journal check.
    const cleared = clearMaintenanceMode(before.owner || `admin:${actor.id}`, true);
    recordAudit({ requestId, actorUserId: actor.id, action: 'maintenance.force_cleared', resourceType: 'maintenance', metadata: { previousReason: before.reason, manualRecoveryRequired: before.manualRecoveryRequired } });
    return apiOk({ cleared, maintenance: getMaintenanceState() }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

async function readJournalSummary(): Promise<{ exists: boolean; phase?: string; restoreId?: string; valid: boolean }> {
  const configured = process.env.DATABASE_PATH?.trim();
  if (!configured || configured === ':memory:' || configured.startsWith('file:')) return { exists: false, valid: true };
  const journalPath = `${path.resolve(configured)}.restore-journal.json`;
  const stat = await fs.lstat(journalPath).catch(() => undefined);
  if (!stat) return { exists: false, valid: true };
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, valid: false };
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, unknown>;
    return {
      exists: true,
      valid: typeof parsed.restoreId === 'string' && typeof parsed.phase === 'string',
      phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
      restoreId: typeof parsed.restoreId === 'string' ? parsed.restoreId : undefined,
    };
  } catch {
    return { exists: true, valid: false };
  }
}
