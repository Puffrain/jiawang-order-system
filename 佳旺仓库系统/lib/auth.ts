import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { hashSync as argon2HashSync, verifySync as argon2VerifySync, type Options as Argon2Options } from '@node-rs/argon2';
import { getDb, withTransaction, type SqliteDatabase } from '@/lib/db';
import {
  hasMinimumRole,
  isRole,
  type PublicUser,
  type Role
} from '@/lib/contracts/platform';
import { acquireWriteLease, releaseWriteLease } from '@/lib/maintenance';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_PASSES = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_KEY_LENGTH = 32;

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  is_active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new Error('Password must contain 8-256 characters');
  }
  const salt = randomBytes(16);
  // @node-rs/argon2 ships a maintained Node 20-compatible native binding;
  // production no longer silently downgrades new passwords to scrypt.
  const encoded = argon2HashSync(password, {
    algorithm: 2 as NonNullable<Argon2Options['algorithm']>,
    memoryCost: ARGON2_MEMORY_KIB,
    timeCost: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    outputLen: ARGON2_KEY_LENGTH,
    salt,
  });
  // Keep the historical application prefix (without the PHC leading `$`) so
  // existing self-tests/records remain readable; verification normalizes it.
  return encoded.startsWith('$') ? encoded.slice(1) : encoded;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    if (encoded.startsWith('argon2id$') || encoded.startsWith('$argon2id$')) {
      const normalized = encoded.startsWith('$') ? encoded : `$${encoded}`;
      const [, algorithm, version, parameters] = normalized.split('$');
      if (algorithm !== 'argon2id' || version !== 'v=19') return false;
      const match = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parameters || '');
      if (!match) return false;
      const memory = Number(match[1]), passes = Number(match[2]), parallelism = Number(match[3]);
      if (![memory, passes, parallelism].every(Number.isSafeInteger) || memory < 8_192 || memory > 1_048_576 || passes < 1 || passes > 10 || parallelism < 1 || parallelism > 16) return false;
      return argon2VerifySync(normalized, password);
    }
    const [algorithm, nText, rText, pText, saltText, digestText] = encoded.split('$');
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (
      algorithm !== 'scrypt' ||
      !Number.isSafeInteger(n) ||
      !Number.isSafeInteger(r) ||
      !Number.isSafeInteger(p) ||
      n < 16_384 ||
      n > 1_048_576 ||
      r < 1 ||
      r > 32 ||
      p < 1 ||
      p > 8
    ) {
      return false;
    }
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    if (salt.length < 8 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

function rowByUsername(db: SqliteDatabase, username: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT id, username, password_hash, role, is_active, created_at, updated_at, last_login_at
       FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`
    )
    .get(normalizeUsername(username)) as UserRow | undefined;
}

function rowById(db: SqliteDatabase, id: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT id, username, password_hash, role, is_active, created_at, updated_at, last_login_at
       FROM users WHERE id = ? LIMIT 1`
    )
    .get(id) as UserRow | undefined;
}

export function getUserByUsername(username: string): PublicUser | null {
  const row = rowByUsername(getDb(), username);
  return row ? toPublicUser(row) : null;
}

export function getUserById(id: string): PublicUser | null {
  const row = rowById(getDb(), id);
  return row ? toPublicUser(row) : null;
}

/** Internal credential lookup. Never return this object from an API. */
export function getUserWithPassword(username: string): (PublicUser & { passwordHash: string }) | null {
  const row = rowByUsername(getDb(), username);
  return row ? { ...toPublicUser(row), passwordHash: row.password_hash } : null;
}

export interface CreateUserOptions {
  username: string;
  password: string;
  role: Role;
}

export function createUser(options: CreateUserOptions): PublicUser {
  const username = normalizeUsername(options.username);
  if (!username || username.length > 64) throw new Error('Invalid username');
  if (!isRole(options.role)) throw new Error('Invalid role');
  const now = new Date().toISOString();
  const id = randomUUID();
  const passwordHash = hashPassword(options.password);
  try {
    withAuthWrite(() => withTransaction((db) => {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).run(id, username, passwordHash, options.role, now, now);
    }));
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      throw new Error('Username already exists');
    }
    throw error;
  }
  const created = getUserById(id);
  if (!created) throw new Error('Unable to create user');
  return created;
}

export function setUserActive(id: string, active: boolean): PublicUser | null {
  const now = new Date().toISOString();
  const result = withAuthWrite(() => getDb()
    .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, now, id));
  return result.changes ? getUserById(id) : null;
}

export function setUserRole(id: string, role: Role): PublicUser | null {
  if (!isRole(role)) throw new Error('Invalid role');
  const now = new Date().toISOString();
  const result = withAuthWrite(() => getDb().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now, id));
  return result.changes ? getUserById(id) : null;
}

/** Atomically apply an administrator's role/active changes. Last-admin and
 * self-deactivation checks happen in the same write transaction, preventing
 * two concurrent admin sessions from removing every active administrator or
 * partially applying a combined patch. */
export function updateUserAdmin(id: string, actorId: string, patch: { role?: Role; isActive?: boolean }): PublicUser | null {
  let updated: PublicUser | null = null;
  withAuthWrite(() => withTransaction((db) => {
    const row = db.prepare('SELECT id, username, password_hash, role, is_active, created_at, updated_at, last_login_at FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!row) return;
    const nextRole = patch.role ?? row.role;
    const nextActive = patch.isActive ?? row.is_active === 1;
    if (!isRole(nextRole)) throw new Error('Invalid role');
    if (id === actorId && !nextActive) throw new Error('SELF_DEACTIVATION');
    if (row.role === 'admin' && row.is_active === 1 && (nextRole !== 'admin' || !nextActive)) {
      const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get() as { count: number };
      if (Number(count.count) <= 1) throw new Error('LAST_ADMIN');
    }
    const timestamp = new Date().toISOString();
    db.prepare('UPDATE users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?').run(nextRole, nextActive ? 1 : 0, timestamp, id);
    if (!nextActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    updated = toPublicUser({ ...row, role: nextRole, is_active: nextActive ? 1 : 0, updated_at: timestamp });
  }));
  return updated;
}

export function countActiveAdmins(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get() as {
    count: number;
  };
  return Number(row.count);
}

export function updateLastLogin(id: string): void {
  const now = new Date().toISOString();
  withAuthWrite(() => getDb().prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, id));
}

/** Change a user's password after verifying the current credential. All
 * existing sessions are revoked so a leaked session cannot survive rotation. */
export function changePassword(userId: string, currentPassword: string, nextPassword: string): PublicUser {
  if (typeof currentPassword !== 'string' || typeof nextPassword !== 'string') throw new Error('INVALID_PASSWORD');
  if (nextPassword.length < 8 || nextPassword.length > 256) throw new Error('INVALID_PASSWORD');
  let changed: PublicUser | null = null;
  withAuthWrite(() => withTransaction((db) => {
    const row = rowById(db, userId);
    if (!row || row.is_active !== 1 || !verifyPassword(currentPassword, row.password_hash)) throw new Error('INVALID_CURRENT_PASSWORD');
    const hash = hashPassword(nextPassword);
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    changed = toPublicUser({ ...row, password_hash: hash, updated_at: now });
  }));
  if (!changed) throw new Error('INVALID_CURRENT_PASSWORD');
  return changed;
}

export function authenticateCredentials(username: string, password: string): PublicUser | null {
  const user = getUserWithPassword(username);
  // Do a dummy hash when the username is unknown to reduce account enumeration
  // timing differences. This value is intentionally not persisted.
  const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const valid = verifyPassword(password, hash);
  if (!user || !valid || !user.isActive) return null;
  // Migrate legacy scrypt records or outdated Argon2 parameters on a
  // successful login. The CAS keeps a concurrent password change from
  // being overwritten while retaining the user's session semantics.
  const nextHash = needsPasswordRehash(user.passwordHash) ? hashPassword(password) : user.passwordHash;
  const timestamp = new Date().toISOString();
  withAuthWrite(() => withTransaction((db) => {
    db.prepare('UPDATE users SET password_hash = ?, last_login_at = ?, updated_at = ? WHERE id = ? AND password_hash = ? AND is_active = 1')
      .run(nextHash, timestamp, timestamp, user.id, user.passwordHash);
  }));
  const refreshed = getUserById(user.id);
  return refreshed?.isActive ? refreshed : null;
}

function needsPasswordRehash(encoded: string): boolean {
  if (!(encoded.startsWith('argon2id$') || encoded.startsWith('$argon2id$'))) return true;
  const normalized = encoded.startsWith('$') ? encoded : `$${encoded}`;
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(normalized);
  return !match || Number(match[1]) !== ARGON2_MEMORY_KIB || Number(match[2]) !== ARGON2_PASSES || Number(match[3]) !== ARGON2_PARALLELISM;
}

const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-bootstrap-password');

export function ensureBootstrapAdmin(): PublicUser | null {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return null;
  if (getUserByUsername(username)) return null;
  try {
    return createUser({ username, password, role: 'admin' });
  } catch (error) {
    // Another web/worker process may win the first-user race. Treat the
    // resulting uniqueness conflict as an idempotent bootstrap.
    if (error instanceof Error && /already exists|unique constraint/i.test(error.message)) return null;
    throw error;
  }
}

export function roleAtLeast(actual: Role, required: Role): boolean {
  return hasMinimumRole(actual, required);
}

export function listUsers(): PublicUser[] {
  const rows = getDb()
    .prepare(
      `SELECT id, username, password_hash, role, is_active, created_at, updated_at, last_login_at
       FROM users ORDER BY username ASC`
    )
    .all() as UserRow[];
  return rows.map(toPublicUser);
}

/** Serialize identity/session mutations behind the same maintenance fence
 * used by uploads and backup/restore. Reads intentionally do not acquire a
 * lease so dashboard/SSE requests remain available during maintenance. */
function withAuthWrite<T>(operation: () => T): T {
  const lease = acquireWriteLease('auth.user');
  try { return operation(); }
  finally { releaseWriteLease(lease); }
}
