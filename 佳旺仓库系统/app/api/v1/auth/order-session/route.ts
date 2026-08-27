import { createHash, randomUUID } from 'node:crypto';
import { apiError, apiOk, handleApiError } from '@/lib/api';
import { withTransaction } from '@/lib/db';
import { integrationHeaders } from '@/lib/integration-auth';
import { assertSameOrigin, getRequestId, parseCookies, setCsrfCookie } from '@/lib/security';
import { createSession, sessionContextFromRequest, setSessionCookie } from '@/lib/session';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    const token = parseCookies(request.headers.get('cookie')).get('hs_session') || '';
    if (token.length < 32 || token.length > 256) return apiError('UNAUTHENTICATED', '请先登录订单系统老板账号', requestId, 401);
    const base = process.env.ORDER_INTERNAL_URL?.replace(/\/$/, '');
    if (!base) return apiError('INTEGRATION_UNAVAILABLE', '订单系统连接尚未配置', requestId, 503);
    const path = '/api/internal/auth/session'; const body = JSON.stringify({ token });
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: integrationHeaders('POST', path, body, randomUUID()), body, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const result = await response.json().catch(() => ({})) as { authenticated?: boolean; user?: { id?: string; phone?: string } };
    if (!response.ok || !result.authenticated || !result.user?.id || !result.user.phone) return apiError('UNAUTHENTICATED', '老板登录已失效，请重新登录', requestId, 401);
    const externalId = `order-owner-${createHash('sha256').update(result.user.id).digest('hex').slice(0, 32)}`; const now = new Date().toISOString();
    let warehouseUserId = externalId;
    withTransaction((db) => {
      // The phone may already have a warehouse account created manually.
      // Reuse that account instead of violating the unique username constraint.
      const existingById = db.prepare('SELECT id FROM users WHERE id=?').get(externalId) as { id: string } | undefined;
      const existingByUsername = db.prepare('SELECT id FROM users WHERE username=?').get(result.user!.phone) as { id: string } | undefined;
      warehouseUserId = existingById?.id || existingByUsername?.id || externalId;
      if (existingById || existingByUsername) {
        db.prepare(`UPDATE users SET username=?,role='admin',is_active=1,updated_at=? WHERE id=?`).run(result.user!.phone, now, warehouseUserId);
      } else {
        db.prepare(`INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,'sso-only','admin',1,?,?)`).run(warehouseUserId, result.user!.phone, now, now);
      }
    });
    const session = createSession(warehouseUserId, sessionContextFromRequest(request)); const output = apiOk({ user: { id: warehouseUserId, username: result.user.phone, role: 'admin', isActive: true, createdAt: now, lastLoginAt: now } }, requestId); setSessionCookie(output, session.token, session.expiresAt); setCsrfCookie(output); return output;
  } catch (error) { return handleApiError(error, requestId); }
}
