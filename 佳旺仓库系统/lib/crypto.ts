import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

const PREFIX = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeMasterKey(raw: string): Buffer {
  const value = raw.trim();
  // Prefer explicit encodings so operators can rotate keys without ambiguity.
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const base64 = Buffer.from(value, 'base64');
    if (base64.length === KEY_BYTES && base64.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
      return base64;
    }
  } catch {
    // Fall through to the deterministic derivation below.
  }
  // A passphrase is accepted for local development and is stretched to a
  // fixed-size key. Production deployments should provide 32 random bytes
  // encoded as hex/base64 and rotate APP_MASTER_KEY deliberately.
  return createHash('sha256').update(value, 'utf8').digest();
}

export function getMasterKey(raw = process.env.APP_MASTER_KEY): Buffer {
  if (!raw || !raw.trim()) {
    throw new Error('APP_MASTER_KEY is required for encrypted configuration');
  }
  const key = decodeMasterKey(raw);
  if (key.length !== KEY_BYTES) throw new Error('APP_MASTER_KEY must resolve to 32 bytes');
  return key;
}

/** Encrypt a secret using AES-256-GCM. The returned value is safe to persist. */
export function encryptSecret(plaintext: string, rawKey?: string): string {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(rawKey), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

export function decryptSecret(payload: string, rawKey?: string): string {
  if (typeof payload !== 'string') throw new TypeError('payload must be a string');
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('Unsupported encrypted value');
  const [, ivEncoded, tagEncoded, dataEncoded] = parts;
  const iv = Buffer.from(ivEncoded, 'base64url');
  const tag = Buffer.from(tagEncoded, 'base64url');
  const data = Buffer.from(dataEncoded, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', getMasterKey(rawKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown, rawKey?: string): string {
  return encryptSecret(JSON.stringify(value), rawKey);
}

export function decryptJson<T>(payload: string, rawKey?: string): T {
  const value = JSON.parse(decryptSecret(payload, rawKey)) as T;
  return value;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 4) return '••••';
  return `${secret.slice(0, 2)}••••${secret.slice(-2)}`;
}

