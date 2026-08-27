import { getDb, type SqliteDatabase } from '@/lib/db';
import { acquireWriteLease, releaseWriteLease } from '@/lib/maintenance';

const REDACT_KEYS = /password|passwd|token|secret|authorization|cookie|api.?key|original.?path/i;

export interface AuditEvent {
  requestId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 1024) return `${value.slice(0, 1024)}…`;
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = REDACT_KEYS.test(key) ? '[redacted]' : redact(child, depth + 1);
  }
  return output;
}

function metadataJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(redact(value));
    return encoded.length > 8192 ? `${encoded.slice(0, 8192)}…` : encoded;
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

export function recordAuditWithDb(db: SqliteDatabase, event: AuditEvent): void {
  db
      .prepare(
        `INSERT INTO audit_log
         (request_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.requestId ?? null,
        event.actorUserId ?? null,
        event.action.slice(0, 128),
        event.resourceType?.slice(0, 128) ?? null,
        event.resourceId?.slice(0, 256) ?? null,
        metadataJson(event.metadata),
        new Date().toISOString()
      );
}

export function recordAudit(event: AuditEvent): void {
  const lease = acquireWriteLease('audit.log');
  try {
    recordAuditWithDb(getDb(), event);
  } finally {
    releaseWriteLease(lease);
  }
}

export interface AuditRecord {
  id: number;
  requestId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  createdAt: string;
}

export function listAudit(limit = 100, offset = 0): AuditRecord[] {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
  const boundedOffset = Math.max(Math.floor(offset), 0);
  const rows = getDb()
    .prepare(
      `SELECT id, request_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at
       FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(boundedLimit, boundedOffset) as Array<{
    id: number;
    request_id: string | null;
    actor_user_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata_json: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata_json ? safeParse(row.metadata_json) : null,
    createdAt: row.created_at
  }));
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { unavailable: true };
  }
}
