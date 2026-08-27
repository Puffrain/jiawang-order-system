import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordValidationError(value: unknown) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH) return `密码至少需要 ${PASSWORD_MIN_LENGTH} 位`;
  if (value.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`;
  return null;
}

export function hashPassword(password: string) {
  const error = passwordValidationError(password);
  if (error) throw new Error(error);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  if (passwordValidationError(password) || typeof stored !== "string") return false;
  const [algorithm, salt, expectedHex] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !/^[a-f0-9]+$/i.test(expectedHex || "")) return false;
  const actual = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
