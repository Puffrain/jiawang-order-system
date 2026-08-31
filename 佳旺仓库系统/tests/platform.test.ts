import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, roleAtLeast, verifyPassword } from '@/lib/auth';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { parseDeepSeekConfigInput } from '@/lib/validation';

test('password hashes verify and reject a different password', () => {
  const encoded = hashPassword('test-password-123');
  assert.equal(verifyPassword('test-password-123', encoded), true);
  assert.equal(verifyPassword('test-password-124', encoded), false);
});

test('RBAC hierarchy is monotonic', () => {
  assert.equal(roleAtLeast('admin', 'reviewer'), true);
  assert.equal(roleAtLeast('reviewer', 'admin'), false);
  assert.equal(roleAtLeast('viewer', 'viewer'), true);
});

test('AES-256-GCM configuration encryption round trips', () => {
  const key = '01'.repeat(32);
  const payload = encryptSecret('not-for-logs', key);
  assert.equal(decryptSecret(payload, key), 'not-for-logs');
  assert.throws(() => decryptSecret(payload, '02'.repeat(32)));
});

test('DeepSeek price table accepts bounded integer rates and rejects malformed entries', () => {
  const parsed = parseDeepSeekConfigInput({ priceTable: [{ model: 'vision-a', version: '2026-08', currency: 'CNY', promptPriceMinor: 3, completionPriceMinor: 5 }] });
  assert.equal(parsed.priceTable?.[0]?.completionPriceMinor, 5);
  assert.throws(() => parseDeepSeekConfigInput({ priceTable: [{ model: 'vision-a', version: 'x', currency: 'cn', promptPriceMinor: 1, completionPriceMinor: 1 }] }));
});
