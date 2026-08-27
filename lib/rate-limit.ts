import { createHash } from "node:crypto";
import db from "@/lib/db";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function consumeRateLimit(bucket: string, key: string, limit: number, windowSeconds: number) {
  const keyHash = digest(key);
  const windowModifier = `-${Math.max(1, Math.floor(windowSeconds))} seconds`;
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM rate_limit_events WHERE created_at < datetime('now', '-2 days')").run();
    const row = db.prepare("SELECT COUNT(*) AS count FROM rate_limit_events WHERE bucket = ? AND key_hash = ? AND created_at >= datetime('now', ?)").get(bucket, keyHash, windowModifier) as { count: number };
    if (row.count >= limit) return false;
    db.prepare("INSERT INTO rate_limit_events (bucket, key_hash) VALUES (?, ?)").run(bucket, keyHash);
    return true;
  });
  return transaction();
}

export const hashNetworkValue = digest;
