import { createHash, randomUUID } from "node:crypto";
import db from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { isPhone, normalizePhone } from "@/lib/validation";

const fingerprint = (password: string) => createHash("sha256").update(password).digest("hex");

function configuredOwnerAliases(primaryPhone: string) {
  return [...new Set(String(process.env.OWNER_PHONE_ALIASES || "")
    .split(",")
    .map(normalizePhone)
    .filter(phone => phone !== primaryPhone))];
}

function syncOwnerAliases(ownerUserId: string, primaryPhone: string, sharedLoginPhone?: string) {
  const aliases = [...new Set([...configuredOwnerAliases(primaryPhone), ...(sharedLoginPhone && sharedLoginPhone !== primaryPhone ? [sharedLoginPhone] : [])])];
  const invalid = aliases.find(phone => !isPhone(phone));
  if (invalid) throw new Error("OWNER_PHONE_ALIASES contains an invalid phone number");

  for (const phone of aliases) {
    const alias = db.prepare("SELECT owner_user_id ownerUserId FROM owner_phone_aliases WHERE phone=?").get(phone) as { ownerUserId: string } | undefined;
    if (alias && alias.ownerUserId !== ownerUserId) throw new Error("OWNER_PHONE_ALIASES conflicts with another owner");
  }

  db.prepare("DELETE FROM owner_phone_aliases WHERE owner_user_id=?").run(ownerUserId);
  const insert = db.prepare("INSERT INTO owner_phone_aliases(phone,owner_user_id) VALUES(?,?)");
  for (const phone of aliases) insert.run(phone, ownerUserId);
}

export function acknowledgeOwnerEnvironmentSecret(ownerUserId: string) {
  const password = process.env.OWNER_PASSWORD;
  if (typeof password !== "string" || password.length < 10) return;
  db.prepare(`INSERT INTO owner_secret_state(owner_user_id,password_fingerprint) VALUES(?,?) ON CONFLICT(owner_user_id) DO UPDATE SET password_fingerprint=excluded.password_fingerprint,applied_at=CURRENT_TIMESTAMP`).run(ownerUserId, fingerprint(password));
}

export function ensureOwnerFromEnvironment() {
  const existing = db.prepare("SELECT id,phone FROM users WHERE role='owner' LIMIT 1").get() as { id: string; phone: string } | undefined;
  const phone = normalizePhone(process.env.OWNER_PHONE);
  const password = process.env.OWNER_PASSWORD;
  const configured = isPhone(phone) && typeof password === "string" && password.length >= 10;
  if (existing) {
    if (!configured) return { ready: true };
    const passwordFingerprint = fingerprint(password);
    const occupied = db.prepare("SELECT id,role FROM users WHERE phone=? AND id<>?").get(phone, existing.id) as { id: string; role: string } | undefined;
    if (occupied && occupied.role !== "courier") return { ready: false, error: "老板登录号码被其他账号使用" };
    // A courier can share the owner login number without sharing identity or credentials.
    const storedPhone = occupied ? existing.phone : phone;
    const applied = db.prepare("SELECT password_fingerprint passwordFingerprint FROM owner_secret_state WHERE owner_user_id=?").get(existing.id) as { passwordFingerprint: string } | undefined;
    if (applied?.passwordFingerprint === passwordFingerprint && existing.phone === storedPhone) {
      try { db.transaction(() => syncOwnerAliases(existing.id, storedPhone, phone))(); }
      catch { return { ready: false, error: "老板登录号码配置冲突，请确认备用号码未被其他账号使用" }; }
      return { ready: true };
    }
    try {
      db.transaction(() => {
        db.prepare("UPDATE users SET phone=?,password_hash=?,display_name=COALESCE(NULLIF(?,''),display_name),status='active',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(storedPhone, hashPassword(password), process.env.OWNER_NAME || "老板", existing.id);
        db.prepare("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").run(existing.id);
        db.prepare(`INSERT INTO owner_secret_state(owner_user_id,password_fingerprint) VALUES(?,?) ON CONFLICT(owner_user_id) DO UPDATE SET password_fingerprint=excluded.password_fingerprint,applied_at=CURRENT_TIMESTAMP`).run(existing.id, passwordFingerprint);
        syncOwnerAliases(existing.id, storedPhone, phone);
      })();
    } catch {
      return { ready: false, error: "老板账号配置冲突，请确认 OWNER_PHONE 没有被其他账号使用" };
    }
    return { ready: true };
  }
  if (!configured) return { ready: false, error: "老板账号尚未初始化，请在密钥配置中设置 OWNER_PHONE 和至少 10 位的 OWNER_PASSWORD" };
  db.transaction(() => {
    const ownerId = randomUUID();
    db.prepare(`INSERT INTO users (id, phone, role, password_hash, display_name) VALUES (?, ?, 'owner', ?, ?)`).run(ownerId, phone, hashPassword(password), process.env.OWNER_NAME || "老板");
    db.prepare("INSERT INTO owner_secret_state(owner_user_id,password_fingerprint) VALUES(?,?)").run(ownerId, fingerprint(password));
    syncOwnerAliases(ownerId, phone);
  })();
  return { ready: true };
}
