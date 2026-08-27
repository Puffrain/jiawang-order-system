import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekVisionProvider } from '../../lib/ai/provider';

test('DeepSeek API paths cannot escape the configured origin', () => {
  assert.throws(
    () => new DeepSeekVisionProvider({
      baseUrl: 'https://api.example.test',
      model: 'vision-model',
      apiKey: 'placeholder-only',
      modelsPath: '///8.8.8.8/models',
      allowedHosts: ['api.example.test'],
    }),
    /API path is invalid|ENDPOINT_PATH/i,
  );
});

test('production endpoint validation canonicalizes hexadecimal IPv4-mapped IPv6', () => {
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  const previousPrivate = env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT;
  env.NODE_ENV = 'production';
  delete env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT;
  try {
    assert.throws(
      () => new DeepSeekVisionProvider({
        baseUrl: 'https://[::ffff:7f00:1]',
        model: 'vision-model',
        apiKey: 'placeholder-only',
        allowedHosts: ['::ffff:7f00:1'],
      }),
      /internal address|SSRF/i,
    );
  } finally {
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousPrivate === undefined) delete env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT;
    else env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT = previousPrivate;
  }
});
