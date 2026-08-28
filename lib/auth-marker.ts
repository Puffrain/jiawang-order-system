export const AUTH_MARKER_COOKIE = "hs_auth";

type Role = "owner" | "buyer" | "courier";
const encoder = new TextEncoder();

async function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), char => char.charCodeAt(0));

export async function createAuthMarker(role: Role, expiresAtSeconds: number) {
  const payload = `${role}.${expiresAtSeconds}`;
  const signature = await crypto.subtle.sign("HMAC", await key(), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAuthMarker(value?: string): Promise<Role | null> {
  if (!value) return null;
  const [role, expires, signature] = value.split(".");
  if ((role !== "owner" && role !== "buyer" && role !== "courier") || !expires || !signature || Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await key(), fromBase64Url(signature), encoder.encode(`${role}.${expires}`));
    return valid ? role : null;
  } catch { return null; }
}
