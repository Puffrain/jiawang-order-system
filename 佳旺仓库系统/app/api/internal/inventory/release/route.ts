import { apiError, apiOk } from '@/lib/api';
import { getDb } from '@/lib/db';
import { verifyIntegrationRequest } from '@/lib/integration-auth';
import { getRequestId } from '@/lib/security';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const raw = await request.text();
  if (!verifyIntegrationRequest(request, raw)) return apiError('UNAUTHORIZED', 'Unauthorized', requestId, 401);
  let body: { operationId?: string; orderId?: string };
  try { body = JSON.parse(raw) as typeof body; } catch { return apiError('INVALID', 'Invalid JSON', requestId, 400); }
  if (!body.operationId || !body.orderId) return apiError('INVALID', 'Invalid release request', requestId, 400);
  try {
    const db = getDb();
    const result = db.transaction(() => {
      const released = db.prepare(`SELECT operation_id operationId FROM inventory_operations WHERE order_id=? AND kind='release'`).get(body.orderId) as { operationId: string } | undefined;
      if (released) {
        if (released.operationId !== body.operationId) throw new Error('IDEMPOTENCY');
        return { replayed: true };
      }
      const reserved = db.prepare(`SELECT operation_id,lines_json FROM inventory_operations WHERE order_id=? AND kind='reserve'`).get(body.orderId) as { operation_id: string; lines_json: string } | undefined;
      if (!reserved) throw new Error('NOT_FOUND');
      let lines: Array<{ variantId: string; quantity: number }>;
      try { lines = JSON.parse(reserved.lines_json) as typeof lines; } catch { throw new Error('RESTORE_FAILED'); }
      if (!Array.isArray(lines) || !lines.length) throw new Error('RESTORE_FAILED');
      const restore = db.prepare('UPDATE product_variants SET stock=COALESCE(stock,0)+?,updated_at=? WHERE id=?');
      for (const line of lines) {
        if (!line.variantId || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('RESTORE_FAILED');
        const changed = restore.run(line.quantity, new Date().toISOString(), line.variantId);
        if (changed.changes !== 1) throw new Error('RESTORE_FAILED');
      }
      db.prepare(`INSERT INTO inventory_operations(operation_id,order_id,kind,related_operation_id,lines_json,created_at) VALUES(?,?,'release',?,?,?)`).run(body.operationId, body.orderId, reserved.operation_id, reserved.lines_json, new Date().toISOString());
      return { replayed: false };
    }).immediate();
    return apiOk(result, requestId);
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_FOUND') return apiError('NOT_FOUND', 'Reservation not found', requestId, 404);
    if (error instanceof Error && error.message === 'IDEMPOTENCY') return apiError('IDEMPOTENCY_CONFLICT', 'Release request does not match the original request', requestId, 409);
    return apiError('RELEASE_FAILED', 'Reservation could not be released', requestId, 409);
  }
}
