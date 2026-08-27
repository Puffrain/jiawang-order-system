import { randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { getUserById } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { hashToken } from '@/lib/crypto';
import { getClientIp, getUserAgent, parseCookies } from '@/lib/security';
import { hasMinimumRole, type PublicUser, type Role } from '@/lib/contracts/platform';
import { acquireWriteLease, assertNotInMaintenance, releaseWriteLease } from '@/lib/maintenance';

export const SESSION_COOKIE = 'jw_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  expires_at: string;
  last_seen_at: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    readonly code = 'UNAUTHENTICATED'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export function createSession(userId: string, context: SessionContext = {}): CreatedSession {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  assertNotInMaintenance();
  const lease = acquireWriteLease('auth.session');
  try {
    getDb()
      .prepare(
        `INSERT INTO sessions
         (id, token_hash, user_id, expires_at, created_at, last_seen_at, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        hashToken(token),
        userId,
        expires.toISOString(),
        now.toISOString(),
        now.toISOString(),
        context.ip ? hashToken(context.ip) : null,
        context.userAgent?.slice(0, 512) ?? null
      );
  } finally { releaseWriteLease(lease); }
  return { token, expiresAt: expires.toISOString() };
}

function readSession(token: string): SessionRow | undefined {
  if (!token || token.length < 32 || token.length > 256) return undefined;
  return getDb()
    .prepare(
      `SELECT id, token_hash, user_id, expires_at, last_seen_at
       FROM sessions WHERE token_hash = ? LIMIT 1`
    )
    .get(hashToken(token)) as SessionRow | undefined;
}

export function getUserForSessionToken(token: string): PublicUser | null {
  const row = readSession(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }
  const user = getUserById(row.user_id);
  if (!user || !user.isActive) {
    return null;
  }
  // Authentication reads remain read-only. Expired/inactive rows are removed
  // by cleanup rather than as a side effect of a GET/SSE request.
  return user;
}

export function getSessionToken(request: Request): string | null {
  const value = parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE);
  return value && value.length <= 256 ? value : null;
}

export function getSessionUser(request: Request): PublicUser | null {
  const token = getSessionToken(request);
  return token ? getUserForSessionToken(token) : null;
}

export function requireSessionUser(request: Request, requiredRole?: Role, options: { allowMaintenance?: boolean } = {}): PublicUser {
  const user = getSessionUser(request);
  if (!user) throw new AuthError('请先登录');
  if (requiredRole && !hasMinimumRole(user.role, requiredRole)) {
    throw new AuthError('权限不足', 403, 'FORBIDDEN');
  }
  if (!options.allowMaintenance && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) assertNotInMaintenance();
  return user;
}

/** Server component helper. Route handlers should prefer getSessionUser(request). */
export async function getCurrentUser(): Promise<PublicUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? getUserForSessionToken(token) : null;
}

export function revokeSessionToken(token: string): void {
  if (!token) return;
  assertNotInMaintenance();
  const lease = acquireWriteLease('auth.session');
  try { getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)); }
  finally { releaseWriteLease(lease); }
}

export function revokeAllUserSessions(userId: string): number {
  assertNotInMaintenance();
  const lease = acquireWriteLease('auth.session');
  try { return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes; }
  finally { releaseWriteLease(lease); }
}

export function setSessionCookie(response: Response, token: string, expiresAt: string): void {
  const nextResponse = response as Response & {
    cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
  };
  if (!nextResponse.cookies?.set) return;
  nextResponse.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSessionCookie(response: Response): void {
  const nextResponse = response as Response & {
    cookies?: { set: (name: string, value: string, options: Record<string, unknown>) => void };
  };
  nextResponse.cookies?.set?.(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0)
  });
}

export function sessionContextFromRequest(request: Request): SessionContext {
  return { ip: getClientIp(request), userAgent: getUserAgent(request) };
}
