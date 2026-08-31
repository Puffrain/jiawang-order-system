import { getPipelineRuntime } from "../lib/jobs/runtime";
import { processQueuedBackups, processQueuedRestores } from "../lib/backup/service";
import { processQueuedExports } from "../lib/export/service";
import { processReviewSyncOutbox } from "../lib/catalog/review-sync";
import { processOrderSyncOutbox } from "../lib/order-sync";
import { getMaintenanceState, isMaintenanceError } from "../lib/maintenance";

export interface WorkerOptions {
  pollMs?: number;
  once?: boolean;
  jobId?: string;
  signal?: AbortSignal;
}

/** Run one or more durable jobs. The loop is safe to restart: expired leases
 * are requeued before each poll and each item transition is persisted. */
export async function runPipelineWorker(options: WorkerOptions = {}): Promise<void> {
  const pollMs = Math.max(100, Math.min(options.pollMs ?? 1_000, 60_000));
  // Resolve the runtime for each operation.  A successful restore closes and
  // invalidates the old SQLite-backed singleton while this loop is alive.
  const runOne = async (jobId: string) => {
    if (maintenanceActive()) return;
    try {
      await getPipelineRuntime().runner.run(jobId);
    } catch (error) {
      // Entering a backup/restore window between the poll and claim is an
      // expected race; leave the job queued for the next poll.
      if (!isMaintenanceError(error)) throw error;
    }
  };
  if (options.jobId) { await runOne(options.jobId); return; }
  do {
    const maintenance = readMaintenanceState();
    if (maintenance?.active) {
      // A restore switch journal is deliberately allowed to keep the service
      // fenced across a worker restart.  Once the owning process is gone (or
      // its lease has expired), let the durable restore row resume; ordinary
      // backup maintenance remains untouched until its owner finishes.
      if (maintenance.owner?.startsWith('restore:') && !maintenance.manualRecoveryRequired && restoreOwnerCanResume(maintenance)) {
        try { await processQueuedRestores(1); }
        catch (error) { if (!isMaintenanceError(error)) { /* durable row/journal remains for the next poll */ } }
        if (options.once || options.signal?.aborted) return;
        if (!maintenanceActive()) continue;
      }
      if (options.once || options.signal?.aborted) return;
      await wait(pollMs, options.signal);
      continue;
    }
    // Keep the reference local to this poll, but refresh it after restore
    // processing below. A successful restore swaps the SQLite database and
    // resets the runtime singleton; continuing to use the pre-restore store
    // would claim/read jobs from the closed database.
    let runtime = getPipelineRuntime();
    // The first poll check can race a backup/restore that starts immediately
    // afterwards. Re-check before recover(), which writes lease/requeue state;
    // ImportJobRunner.recover also carries the runtime gate as a final guard.
    if (maintenanceActive()) {
      if (options.once || options.signal?.aborted) return;
      await wait(pollMs, options.signal);
      continue;
    }
    runtime.runner.recover();
    try { if (runtime.catalog) processReviewSyncOutbox(runtime.store, 50); }
    catch (error) {
      if (!isMaintenanceError(error)) {
        // Rows remain durable and idempotent for the next worker poll.
      }
    }
    try { await processOrderSyncOutbox(20); } catch { /* durable rows retry on the next poll */ }
    try {
      // Backups are durable jobs in the same worker process.  The service
      // claims its own owner-aware maintenance window and blocks pipeline
      // leases while taking the snapshot.
      await processQueuedBackups(1);
    } catch (error) {
      if (!isMaintenanceError(error)) {
        // A failed backup row is durable and can be inspected by an admin;
        // keep the pipeline worker alive for unrelated queued work.
      }
    }
    try { await processQueuedExports(1); }
    catch (error) {
      if (!isMaintenanceError(error)) {
        // Export failures are persisted on export_jobs; unrelated imports
        // should continue polling.
      }
    }
    try { await processQueuedRestores(1); }
    catch (error) {
      if (!isMaintenanceError(error)) {
        // Restore failures are persisted on restore_jobs; continue polling.
      }
    }
    runtime = getPipelineRuntime();
    if (maintenanceActive()) {
      if (options.once || options.signal?.aborted) return;
      await wait(pollMs, options.signal);
      continue;
    }
    // A paused job is an operator checkpoint, not a retry queue.  Budget
    // exhaustion, provider capability failures, and unknown usage all leave a
    // durable pause that must remain untouched until an explicit resume action
    // requeues it.  Automatically acquiring it here would immediately repeat
    // the same failure (and, for unknown usage, could double charge a request).
    const queued = runtime.store.listJobs(50).filter((job) => job.status === "queued");
    for (const job of queued) {
      if (options.signal?.aborted) return;
      await runOne(job.id);
    }
    if (options.once || options.signal?.aborted) return;
    await wait(pollMs, options.signal);
  } while (!options.signal?.aborted);
}

function maintenanceActive(): boolean {
  return Boolean(readMaintenanceState()?.active);
}

function readMaintenanceState() {
  try {
    return getMaintenanceState();
  } catch {
    // The file-store fallback is explicitly development/test-only and may be
    // used without a native SQLite binding.  In production fail closed when
    // the maintenance state cannot be read.
    return process.env.PIPELINE_USE_FILE_STORE !== "1" ? { active: true, owner: null, manualRecoveryRequired: true } : null;
  }
}

function restoreOwnerCanResume(state: { owner: string | null; leaseExpiresAt?: string | null }): boolean {
  const owner = state.owner || '';
  const match = /^restore:[^:]+:(\d+):/.exec(owner);
  if (match) {
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }
    if (pid === process.pid) return true;
  }
  const expiry = state.leaseExpiresAt ? Date.parse(state.leaseExpiresAt) : NaN;
  return Number.isFinite(expiry) && expiry <= Date.now();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
