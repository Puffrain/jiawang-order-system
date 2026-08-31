import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

test('AI profiles keep secrets private, revisions immutable, and activation explicit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-ai-profiles-'));
  process.env.DATABASE_PATH = path.join(root, 'profiles.db');
  const { getDb, closeDb } = await import('../../lib/db');
  try {
    try { getDb(); } catch { t.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
    process.env.APP_MASTER_KEY = 'ai-profile-test-master-key';
    const { activateAIProfile, copyAIProfile, getActiveAIProfileSecret, listAIProfiles, saveAIProfile } = await import('../../lib/ai-profiles');
    const first = saveAIProfile({ name: 'DeepSeek one', provider: 'deepseek', config: { apiKey: 'sk-secret-one', baseUrl: 'https://example.invalid', model: 'vision-one' } });
    assert.equal(first.config.apiKeyConfigured, true);
    assert.equal(first.config.apiKey, undefined);
    assert.equal(first.config.apiKeyHint, 'sk••••ne');
    const second = saveAIProfile({ name: 'DeepSeek one', provider: 'deepseek', config: { model: 'vision-two' } }, first.id);
    assert.equal(second.revision, first.revision + 1);
    assert.equal(second.config.apiKeyConfigured, true);
    const activeBefore = getActiveAIProfileSecret();
    assert.equal(activeBefore?.revision, first.revision);
    activateAIProfile(first.id);
    const activeAfter = getActiveAIProfileSecret();
    assert.equal(activeAfter?.revision, second.revision);
    const copy = copyAIProfile(first.id, 'OpenAI copy');
    assert.notEqual(copy.id, first.id);
    assert.equal(copy.config.apiKeyConfigured, true);
    const cleared = saveAIProfile({ name: 'OpenAI copy', provider: 'deepseek', config: {}, clearApiKey: true }, copy.id);
    assert.equal(cleared.config.apiKeyConfigured, false);
    assert.equal(listAIProfiles().every((profile) => profile.config.apiKey === undefined), true);
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    delete process.env.APP_MASTER_KEY;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI profile provider type cannot drift across revisions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jw-ai-profile-provider-'));
  process.env.DATABASE_PATH = path.join(root, 'profiles.db');
  const { getDb, closeDb } = await import('../../lib/db');
  try {
    try { getDb(); } catch { t.skip('better-sqlite3 native binding is unavailable for this Node runtime'); return; }
    process.env.APP_MASTER_KEY = 'ai-profile-provider-test-key';
    const { saveAIProfile } = await import('../../lib/ai-profiles');
    const profile = saveAIProfile({ name: 'Provider lock', provider: 'openai', config: { apiKey: 'secret' } });
    assert.throws(() => saveAIProfile({ name: 'Provider lock', provider: 'deepseek', config: {} }, profile.id), /供应商类型|AI_PROFILE_PROVIDER_IMMUTABLE/);
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    delete process.env.APP_MASTER_KEY;
    await fs.rm(root, { recursive: true, force: true });
  }
});
