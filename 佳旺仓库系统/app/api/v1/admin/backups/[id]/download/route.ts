import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { handleApiError } from '@/lib/api';
import { BackupDownloadError, beginBackupDownload } from '@/lib/backup/service';
import { getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stream a completed backup as a one-time artifact.
 *
 * The service keeps `backup_jobs.output_path` pointing at the canonical file
 * while this response is in flight and owns a durable lock sidecar.  The DB
 * row is cleared only after the source stream emits `end`; cancellation and
 * read errors release the lock while retaining the artifact for retry. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    const actor = requireSessionUser(request, 'admin');
    const { id } = await context.params;
    const claim = await beginBackupDownload(id);
    const source = createReadStream(claim.filePath, { flags: 'r' });
    let ended = false;
    let failed = false;
    let finalized = false;
    const heartbeat = setInterval(() => {
      void claim.touch().catch(() => {
        if (!ended && !failed) source.destroy(new BackupDownloadError('BACKUP_DOWNLOAD_FENCED', '备份下载租约已失效', 409));
      });
    }, 10_000);
    heartbeat.unref?.();

    const abort = () => {
      if (ended || failed || finalized) return;
      failed = true;
      clearInterval(heartbeat);
      void claim.abort().catch(() => undefined);
    };
    source.once('error', abort);
    source.once('close', () => { if (!ended) abort(); });
    source.once('end', () => {
      ended = true;
      clearInterval(heartbeat);
      void (async () => {
        try {
          await claim.complete();
          finalized = true;
          try {
            recordAudit({
              requestId,
              actorUserId: actor.id,
              action: 'backup.downloaded',
              resourceType: 'backup',
              resourceId: id,
              metadata: { bytes: claim.bytes },
            });
          } catch {
            // The artifact was already delivered and durably consumed. An
            // audit storage outage must not trigger a second destructive
            // cleanup or make the client retry a successful download.
          }
        } catch {
          // The body has ended, so an HTTP status cannot be changed. The
          // finalizing lock remains durable for the next request/worker to
          // reconcile; importantly, no bytes are deleted on this path unless
          // the database claim succeeded.
        }
      })();
    });

    // Record an intent before the stream starts. If the audit database is
    // unavailable, release the claim and fail the request while the backup is
    // still intact.
    try {
      recordAudit({
        requestId,
        actorUserId: actor.id,
        action: 'backup.download_started',
        resourceType: 'backup',
        resourceId: id,
        metadata: { bytes: claim.bytes },
      });
    } catch (error) {
      abort();
      source.destroy();
      throw error;
    }

    const body = Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(claim.bytes),
        'content-disposition': `attachment; filename="${safeFilename(claim.filename)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

function safeFilename(value: string): string {
  const basename = path.basename(value).replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim();
  return (basename || 'backup.jwbackup').slice(0, 180);
}
