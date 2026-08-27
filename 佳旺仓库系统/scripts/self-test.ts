import assert from 'node:assert/strict';
import { hashPassword, roleAtLeast, verifyPassword } from '@/lib/auth';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { parseCreateUserInput } from '@/lib/validation';

const password = 'correct horse battery staple';
const encoded = hashPassword(password);
assert.match(encoded, /^(?:argon2id|scrypt)\$/);
assert.equal(verifyPassword(password, encoded), true);
assert.equal(verifyPassword('wrong password', encoded), false);

assert.equal(roleAtLeast('admin', 'reviewer'), true);
assert.equal(roleAtLeast('reviewer', 'admin'), false);
assert.equal(roleAtLeast('viewer', 'viewer'), true);

const key = 'ab'.repeat(32);
const encrypted = encryptSecret('deepseek-secret', key);
assert.notEqual(encrypted.includes('deepseek-secret'), true);
assert.equal(decryptSecret(encrypted, key), 'deepseek-secret');
assert.throws(() => decryptSecret(encrypted, 'cd'.repeat(32)));

assert.deepEqual(parseCreateUserInput({ username: 'Reviewer_1', password, role: 'reviewer' }), {
  username: 'reviewer_1',
  password,
  role: 'reviewer'
});

process.stdout.write('Platform self-test passed: password KDF, RBAC, validation and AES-256-GCM\n');
