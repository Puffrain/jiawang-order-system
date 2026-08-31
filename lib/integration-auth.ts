import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import db from "@/lib/db";

const WINDOW_MS = 5 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

db.exec(`CREATE TABLE IF NOT EXISTS integration_nonces (
  nonce TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); CREATE INDEX IF NOT EXISTS idx_integration_nonces_expiry ON integration_nonces(expires_at);`);

function secret(): string {
  const value = process.env.INTEGRATION_SHARED_SECRET?.trim();
  if (!value || value.length < 32) throw new Error("INTEGRATION_SHARED_SECRET is not configured");
  return value;
}

function canonical(method: string, pathname: string, body: string, timestamp: string, nonce: string) {
  return `${timestamp}.${nonce}.${method.toUpperCase()}.${pathname}.${digest(body)}`;
}

export function integrationHeaders(method: string, pathname: string, body: string, nonce: string) {
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret()).update(canonical(method, pathname, body, timestamp, nonce)).digest("hex");
  return { "content-type": "application/json", "x-integration-timestamp": timestamp, "x-integration-nonce": nonce, "x-integration-signature": signature };
}

export function verifyIntegrationRequest(request: Request, body: string) {
  const timestamp = request.headers.get("x-integration-timestamp") || "";
  const nonce = request.headers.get("x-integration-nonce") || "";
  const supplied = request.headers.get("x-integration-signature") || "";
  const time = Number(timestamp);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(nonce) || !Number.isFinite(time) || Math.abs(Date.now() - time) > WINDOW_MS || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret()).update(canonical(request.method, new URL(request.url).pathname, body, timestamp, nonce)).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return false;
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM integration_nonces WHERE datetime(expires_at)<=CURRENT_TIMESTAMP").run();
      db.prepare("INSERT INTO integration_nonces(nonce,expires_at) VALUES(?,?)").run(nonce, new Date(Date.now() + WINDOW_MS).toISOString());
    })();
    return true;
  } catch { return false; }
}
