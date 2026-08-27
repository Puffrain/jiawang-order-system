import db from "@/lib/db";

export type OwnerLoginRecord = { id: string; passwordHash?: string };

export function findActiveOwnerByLoginPhone(phone: string) {
  return db.prepare(`
    SELECT u.id, u.password_hash AS passwordHash
    FROM users u
    LEFT JOIN owner_phone_aliases a ON a.owner_user_id = u.id
    WHERE u.role='owner' AND u.status='active' AND (u.phone=? OR a.phone=?)
    LIMIT 1
  `).get(phone, phone) as OwnerLoginRecord | undefined;
}
