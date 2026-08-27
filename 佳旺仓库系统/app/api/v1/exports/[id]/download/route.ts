import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { apiError, handleApiError } from '@/lib/api';
import { assertExportPath, getExportJob } from '@/lib/export/service';
import { getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'viewer');
    const { id } = await context.params;
    const job = getExportJob(id);
    if (!job) return apiError('NOT_FOUND', '导出任务不存在', requestId, 404);
    if (actor.role !== 'admin' && job.requestedBy !== actor.id) return apiError('FORBIDDEN', '无权下载该导出', requestId, 403);
    const filePath = assertExportPath(job);
    const stream = createReadStream(filePath, { flags: 'r' });
    try {
      recordAudit({ requestId, actorUserId: actor.id, action: 'export.downloaded', resourceType: 'export', resourceId: id });
    } catch (error) {
      stream.destroy();
      throw error;
    }
    const stat = await import('node:fs/promises').then((module) => module.stat(filePath));
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'content-type': job.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${path.basename(filePath)}"`,
        'content-length': String(stat.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId,
      },
    });
  } catch (error) { return handleApiError(error, requestId); }
}
