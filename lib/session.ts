import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import db from "@/lib/db";
import { setSessionCookie, IFRAME_SAFE_COOKIE_OPTS } from "@/lib/iframe-safe-cookie";
import { hashNetworkValue } from "@/lib/rate-limit";
import { AUTH_MARKER_COOKIE, createAuthMarker } from "@/lib/auth-marker";

export const SESSION_COOKIE = "hs_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, role: "owner" | "buyer" | "courier", request: Request, response: NextResponse) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), userId, tokenHash(token), expiresAt, hashNetworkValue(ip), request.headers.get("user-agent")?.slice(0, 300) ?? null,
  );
  setSessionCookie(response, SESSION_COOKIE, token, SESSION_SECONDS);
  setSessionCookie(response, AUTH_MARKER_COOKIE, await createAuthMarker(role, Math.floor(Date.now() / 1000) + SESSION_SECONDS), SESSION_SECONDS);
}

export async function currentSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = db.prepare(`SELECT s.id AS sessionId, s.user_id AS userId, u.phone, u.role, u.display_name AS displayName, u.tour_completed AS tourCompleted FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > CURRENT_TIMESTAMP AND u.status = 'active'`).get(tokenHash(token)) as { sessionId: string; userId: string; phone: string; role: "owner" | "buyer" | "courier"; displayName: string | null; tourCompleted: number } | undefined;
  return row ?? null;
}

export async function revokeCurrentSession(response: NextResponse) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) db.prepare("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(tokenHash(token));
  response.cookies.set(SESSION_COOKIE, "", { ...IFRAME_SAFE_COOKIE_OPTS, maxAge: 0 });
  response.cookies.set(AUTH_MARKER_COOKIE, "", { ...IFRAME_SAFE_COOKIE_OPTS, maxAge: 0 });
}
