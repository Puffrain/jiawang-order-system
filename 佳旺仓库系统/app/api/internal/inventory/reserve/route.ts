import { apiError, apiOk } from '@/lib/api';
import { getDb } from '@/lib/db';
import { verifyIntegrationRequest } from '@/lib/integration-auth';
import { getRequestId } from '@/lib/security';

export const runtime = 'nodejs';

type Line = { variantId: string; quantity: number };
const canonicalLines = (lines: Line[]) => JSON.stringify([...lines].sort((a,b)=>a.variantId.localeCompare(b.variantId)));

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const raw = await request.text();
  if (!verifyIntegrationRequest(request, raw)) return apiError('UNAUTHORIZED', 'Unauthorized', requestId, 401);
  let body: { operationId?: string; orderId?: string; lines?: Line[] };
  try { body = JSON.parse(raw) as typeof body; } catch { return apiError('INVALID', 'Invalid JSON', requestId, 400); }
  if (!body.operationId || !body.orderId || !Array.isArray(body.lines) || !body.lines.length || body.lines.length > 500) {
    return apiError('INVALID', 'Invalid inventory request', requestId, 400);
  }
  try {
    const db = getDb();
    const result = db.transaction(() => {
      if (new Set(body.lines!.map((line) => line.variantId)).size !== body.lines!.length) throw new Error('INVALID');
      for (const line of body.lines!) if (!line.variantId || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('INVALID');
      const linesJson = canonicalLines(body.lines!);
      const replay = db.prepare(`SELECT operation_id operationId,lines_json linesJson FROM inventory_operations WHERE order_id=? AND kind='reserve'`).get(body.orderId) as { operationId: string; linesJson: string } | undefined;
      if (replay) {
        if (replay.operationId !== body.operationId || canonicalLines(JSON.parse(replay.linesJson) as Line[]) !== linesJson) throw new Error('IDEMPOTENCY');
        return { replayed: true, levels: currentLevels(body.lines!) };
      }
      const reserve = db.prepare(`
        UPDATE product_variants
        SET stock=stock-?,updated_at=?
        WHERE id=?
          AND deleted_at IS NULL
          AND stock>=?
          AND EXISTS (
            SELECT 1 FROM products
            WHERE products.id=product_variants.product_id
              AND products.status='published'
          )
      `);
      for (const line of body.lines!) {
        const changed = reserve.run(line.quantity, new Date().toISOString(), line.variantId, line.quantity);
        if (changed.changes !== 1) throw new Error('STOCK');
      }
      db.prepare(`INSERT INTO inventory_operations(operation_id,order_id,kind,lines_json,created_at) VALUES(?,?,'reserve',?,?)`).run(body.operationId, body.orderId, linesJson, new Date().toISOString());
      return { replayed: false, levels: currentLevels(body.lines!) };
    }).immediate();
    return apiOk(result, requestId);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INVALID';
    return apiError(code === 'STOCK' ? 'INSUFFICIENT_STOCK' : code === 'IDEMPOTENCY' ? 'IDEMPOTENCY_CONFLICT' : 'INVALID', code === 'STOCK' ? '库存不足' : code === 'IDEMPOTENCY' ? '库存请求与原请求不一致' : '库存请求无效', requestId, 409);
  }
}

function currentLevels(lines: Line[]) {
  const statement = getDb().prepare('SELECT COALESCE(stock,0) stock FROM product_variants WHERE id=?');
  return lines.map(line => ({ variantId: line.variantId, stock: Number((statement.get(line.variantId) as { stock?: number } | undefined)?.stock || 0) }));
}
