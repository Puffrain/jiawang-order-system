import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, SecurityError } from '@/lib/security';

test('state-changing requests fail closed for missing origin, CSRF and JSON type', () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = { origin: env.REQUIRE_ORIGIN, csrf: env.REQUIRE_CSRF, app: env.APP_ORIGIN };
  env.REQUIRE_ORIGIN = 'true'; env.REQUIRE_CSRF = 'true'; env.APP_ORIGIN = 'https://warehouse.example';
  try {
    const missingOrigin = new Request('https://warehouse.example/api/v1/x', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.throws(() => assertSameOrigin(missingOrigin), (error: unknown) => error instanceof SecurityError && error.code === 'ORIGIN_REQUIRED');
    const wrongType = new Request('https://warehouse.example/api/v1/x', { method: 'POST', headers: { origin: 'https://warehouse.example', 'content-type': 'text/plain' } });
    assert.throws(() => assertJsonContentType(wrongType), (error: unknown) => error instanceof SecurityError && error.code === 'UNSUPPORTED_MEDIA_TYPE');
    assert.throws(() => assertCsrfToken(wrongType), (error: unknown) => error instanceof SecurityError && error.code === 'CSRF_REQUIRED');
  } finally {
    if (previous.origin === undefined) delete env.REQUIRE_ORIGIN; else env.REQUIRE_ORIGIN = previous.origin;
    if (previous.csrf === undefined) delete env.REQUIRE_CSRF; else env.REQUIRE_CSRF = previous.csrf;
    if (previous.app === undefined) delete env.APP_ORIGIN; else env.APP_ORIGIN = previous.app;
  }
});

test('double-submit CSRF requires matching cookie and header', () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.REQUIRE_CSRF;
  env.REQUIRE_CSRF = 'true';
  try {
    const valid = new Request('https://warehouse.example/api/v1/x', { method: 'POST', headers: { cookie: 'jw_csrf=abc123', 'x-csrf-token': 'abc123' } });
    assert.doesNotThrow(() => assertCsrfToken(valid));
    const invalid = new Request('https://warehouse.example/api/v1/x', { method: 'POST', headers: { cookie: 'jw_csrf=abc123', 'x-csrf-token': 'wrong' } });
    assert.throws(() => assertCsrfToken(invalid), (error: unknown) => error instanceof SecurityError && error.code === 'CSRF_INVALID');
  } finally {
    if (previous === undefined) delete env.REQUIRE_CSRF; else env.REQUIRE_CSRF = previous;
  }
});
