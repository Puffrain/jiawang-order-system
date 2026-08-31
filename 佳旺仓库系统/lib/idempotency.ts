import { createHash } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { acquireWriteLease, releaseWriteLease } from './maintenance';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyHit {
  statusCode: number;
  response: unknown;
}

export function normalizeIdempotencyKey(value: string | null): string | null {
  const key = value?.trim() || '';
  return KEY_PATTERN.test(key) ? key : null;
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

export function getIdempotent(scope: string, key: string, actorUserId: string, requestHash: string): IdempotencyHit | null {
  pruneIdempotency();
  const row = getDb().prepare('SELECT actor_user_id, request_hash, response_json, status_code FROM api_idempotency WHERE scope = ? AND idem_key = ?').get(scope, key) as { actor_user_id: string; request_hash: string; response_json: string | null; status_code: number | null } | undefined;
  if (!row) return null;
  if (row.actor_user_id !== actorUserId) throw idempotencyError('该幂等键已被其他账号使用', 'IDEMPOTENCY_SCOPE', 409);
  if (row.request_hash !== requestHash) throw idempotencyError('相同幂等键对应的请求内容不同', 'IDEMPOTENCY_CONFLICT', 409);
  if (!row.response_json || !row.status_code) return null;
  return { statusCode: row.status_code, response: JSON.parse(row.response_json) };
}

export function reserveIdempotency(scope: string, key: string, actorUserId: string, requestHash: string): void {
  const created = new Date();
  const expires = new Date(created.getTime() + TTL_MS).toISOString();
  try {
    withTransaction((db) => {
      db.prepare('INSERT INTO api_idempotency (scope, idem_key, actor_user_id, request_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(scope, key, actorUserId, requestHash, created.toISOString(), expires);
    });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) throw idempotencyError('幂等请求正在处理中或已完成', 'IDEMPOTENCY_IN_PROGRESS', 409);
    throw error;
  }
}

export function completeIdempotency(scope: string, key: string, actorUserId: string, requestHash: string, response: unknown, statusCode: number): void {
  const lease = acquireWriteLease('api.idempotency');
  try { getDb().prepare('UPDATE api_idempotency SET response_json = ?, status_code = ? WHERE scope = ? AND idem_key = ? AND actor_user_id = ? AND request_hash = ?').run(JSON.stringify(response), statusCode, scope, key, actorUserId, requestHash); }
  finally { releaseWriteLease(lease); }
}

export function releaseIdempotency(scope: string, key: string, actorUserId: string, requestHash: string): void {
  const lease = acquireWriteLease('api.idempotency');
  try { getDb().prepare('DELETE FROM api_idempotency WHERE scope = ? AND idem_key = ? AND actor_user_id = ? AND request_hash = ? AND response_json IS NULL').run(scope, key, actorUserId, requestHash); }
  finally { releaseWriteLease(lease); }
}

function pruneIdempotency(): void {
  try {
    const lease = acquireWriteLease('api.idempotency');
    try { getDb().prepare('DELETE FROM api_idempotency WHERE expires_at <= ?').run(new Date().toISOString()); }
    finally { releaseWriteLease(lease); }
  } catch (error) {
    // Expiry cleanup is opportunistic; a maintenance fence must not turn a
    // harmless idempotency read into a write failure.
    if (!(error instanceof Error) || !('code' in error) || !['MAINTENANCE', 'MAINTENANCE_BUSY'].includes(String((error as { code?: unknown }).code))) throw error;
  }
}

export function idempotencyError(message: string, code: string, status: number): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number };
  error.code = code;
  error.status = status;
  return error;
}
