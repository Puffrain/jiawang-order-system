import { apiOk, handleApiError } from '@/lib/api';
import { createPublishedExport, listExportJobs, type ExportFormat } from '@/lib/export/service';
import { recordAudit } from '@/lib/audit';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'viewer');
    return apiOk({ exports: listExportJobs(actor.role === 'admin' ? undefined : actor.id) }, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'viewer');
    const body = await parseJson(request) as { format?: ExportFormat };
    const format = body.format ?? 'xlsx';
    const job = createPublishedExport(format, actor.id);
    recordAudit({ requestId, actorUserId: actor.id, action: 'export.created', resourceType: 'export', resourceId: job.id, metadata: { format, rowCount: job.rowCount, status: job.status } });
    return apiOk({ job }, requestId, 202);
  } catch (error) { return handleApiError(error, requestId); }
}
