import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import db from "@/lib/db";

export type OtpPurpose = "buyer_access" | "buyer_register" | "wechat_bind" | "password_reset" | "owner_password_reset";

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET_NOT_CONFIGURED");
  return value;
}
function digest(challengeId: string, phone: string, purpose: OtpPurpose, code: string) {
  return createHmac("sha256", secret()).update(`${challengeId}:${phone}:${purpose}:${code}`).digest("hex");
}

export function createOtpChallenge(phone: string, purpose: OtpPurpose) {
  const id = randomUUID();
  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare("UPDATE verification_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE phone=? AND purpose=? AND consumed_at IS NULL").run(phone, purpose);
  db.prepare("INSERT INTO verification_challenges (id, phone, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, phone, purpose, digest(id, phone, purpose, code), expiresAt);
  return { id, code, expiresAt, purpose };
}

export function verifyOtpChallenge(challengeId: string, phone: string, purpose: OtpPurpose, code: string) {
  return db.transaction(() => {
    const row = db.prepare("SELECT id,code_hash codeHash,attempt_count attemptCount FROM verification_challenges WHERE id=? AND phone=? AND purpose=? AND consumed_at IS NULL AND datetime(expires_at)>CURRENT_TIMESTAMP").get(challengeId, phone, purpose) as { id: string; codeHash: string; attemptCount: number } | undefined;
    if (!row || row.attemptCount >= 5) return false;
    db.prepare("UPDATE verification_challenges SET attempt_count=attempt_count+1 WHERE id=?").run(challengeId);
    const actual = Buffer.from(digest(challengeId, phone, purpose, code), "hex");
    const expected = Buffer.from(row.codeHash, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    db.prepare("UPDATE verification_challenges SET consumed_at=CURRENT_TIMESTAMP WHERE id=?").run(challengeId);
    return true;
  })();
}
