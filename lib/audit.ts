import db from "@/lib/db";
import { hashNetworkValue } from "@/lib/rate-limit";

export type AuditRole = "owner" | "buyer" | "system";

export function writeAudit(input: { actorUserId?: string; actorRole?: AuditRole; action: string; objectType?: string; objectId?: string; metadata?: unknown; ip?: string }) {
  db.prepare(`INSERT INTO audit_logs (actor_user_id, actor_role, action, object_type, object_id, metadata_json, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.actorUserId ?? null,
    input.actorRole ?? "system",
    input.action,
    input.objectType ?? null,
    input.objectId ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    input.ip ? hashNetworkValue(input.ip) : null,
  );
}
