import { getDb, withTransaction } from '../db';
import type { ImportItem, ItemStatus, PipelineError } from '../contracts/pipeline';
import type { PipelineStore } from '../jobs/store';

interface OutboxRow {
  id: string;
  item_id: string;
  job_id: string;
  target_status: ItemStatus;
  patch_json: string;
  attempts: number;
}

const MAX_REVIEW_SYNC_ATTEMPTS = 8;
const TERMINAL_ITEM_STATUSES = new Set<ItemStatus>(['cancelled', 'succeeded', 'failed']);

/** Idempotently reconcile catalog review decisions into PipelineStore. */
export function processReviewSyncOutbox(store: PipelineStore, limit = 50): number {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
  const rows = getDb().prepare(`SELECT id, item_id, job_id, target_status, patch_json, attempts
    FROM review_sync_outbox
    WHERE processed_at IS NULL AND dead_letter_at IS NULL
    ORDER BY created_at, id LIMIT ?`).all(bounded) as OutboxRow[];
  let processed = 0;
  for (const row of rows) {
    try {
      const item = store.getItem(row.item_id);
      if (!item || item.jobId !== row.job_id) {
        markReviewSyncDeadLetter(row.id, '同步目标条目不存在或任务不匹配');
        continue;
      }
      if (!['succeeded', 'failed', 'needs_review'].includes(row.target_status)) {
        markReviewSyncDeadLetter(row.id, '同步目标状态无效');
        continue;
      }
      // A replay after the API already updated the projection is successful
      // without writing it a second time.
      if (item.status === row.target_status) {
        markReviewSyncProcessed(row.id);
        processed += 1;
        continue;
      }
      // PipelineStore deliberately refuses to rewrite terminal decisions. A
      // conflicting terminal therefore cannot become successful on retry;
      // retain it as a durable repair item instead of starving later rows.
      if (TERMINAL_ITEM_STATUSES.has(item.status)) {
        markReviewSyncDeadLetter(row.id, `条目已进入冲突终态：${item.status}`);
        continue;
      }
      const patch = parsePatch(row.patch_json);
      const updated = store.transitionItem(row.item_id, row.target_status, patch);
      if (updated.status !== row.target_status) {
        if (TERMINAL_ITEM_STATUSES.has(updated.status)) {
          markReviewSyncDeadLetter(row.id, `条目已进入冲突终态：${updated.status}`);
          continue;
        }
        throw new Error('条目状态未能同步');
      }
      markReviewSyncProcessed(row.id);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '审核同步失败';
      try {
        const nextAttempt = row.attempts + 1;
        if (nextAttempt >= MAX_REVIEW_SYNC_ATTEMPTS) {
          markReviewSyncDeadLetter(row.id, `超过最大重试次数：${message}`, nextAttempt);
        } else {
          withTransaction((db) => db.prepare(`UPDATE review_sync_outbox
            SET attempts=attempts+1, last_error=?
            WHERE id=? AND processed_at IS NULL AND dead_letter_at IS NULL`).run(message, row.id));
        }
      } catch { /* leave the durable row for the next worker poll */ }
    }
  }
  return processed;
}

export function markReviewSyncProcessed(id: string): void {
  withTransaction((db) => db.prepare(`UPDATE review_sync_outbox
    SET processed_at=?, last_error=NULL
    WHERE id=? AND processed_at IS NULL AND dead_letter_at IS NULL`).run(new Date().toISOString(), id));
}

export function markReviewSyncDeadLetter(id: string, reason: string, attempts?: number): void {
  const timestamp = new Date().toISOString();
  const safeReason = reason.trim().slice(0, 500) || '审核同步需要人工修复';
  withTransaction((db) => {
    if (attempts === undefined) {
      db.prepare(`UPDATE review_sync_outbox
        SET dead_letter_at=?, dead_letter_reason=?, last_error=?
        WHERE id=? AND processed_at IS NULL AND dead_letter_at IS NULL`)
        .run(timestamp, safeReason, safeReason, id);
      return;
    }
    db.prepare(`UPDATE review_sync_outbox
      SET attempts=?, dead_letter_at=?, dead_letter_reason=?, last_error=?
      WHERE id=? AND processed_at IS NULL AND dead_letter_at IS NULL`)
      .run(attempts, timestamp, safeReason, safeReason, id);
  });
}

function parsePatch(value: string): Partial<ImportItem> {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    raw = parsed as Record<string, unknown>;
  } catch { throw new Error('审核同步内容损坏'); }
  const patch: Partial<ImportItem> = {};
  if (typeof raw.category === 'string') patch.category = raw.category.slice(0, 120);
  if (typeof raw.group === 'string') patch.group = raw.group.slice(0, 120);
  if (raw.backLabel && typeof raw.backLabel === 'object' && !Array.isArray(raw.backLabel)) patch.backLabel = raw.backLabel as ImportItem['backLabel'];
  if (typeof raw.manualRequired === 'boolean') patch.manualRequired = raw.manualRequired;
  if (raw.error === null || raw.error === undefined) patch.error = undefined;
  else if (raw.error && typeof raw.error === 'object' && !Array.isArray(raw.error)) {
    const error = raw.error as Record<string, unknown>;
    if (typeof error.code === 'string' && typeof error.message === 'string' && typeof error.class === 'string') {
      patch.error = {
        code: error.code.slice(0, 128),
        message: error.message.slice(0, 500),
        class: error.class as PipelineError['class'],
        retryable: error.retryable === true,
      };
    }
  }
  return patch;
}
