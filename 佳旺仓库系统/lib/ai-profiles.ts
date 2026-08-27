import { createHash, randomUUID } from 'node:crypto';
import type { DeepSeekPriceTableEntry } from './contracts/platform';
import type { ProviderCapabilities } from './contracts/pipeline';
import { decryptJson, encryptJson, maskSecret } from './crypto';
import { getDb, withTransaction, type SqliteDatabase } from './db';

export type AIProfileProvider = 'deepseek' | 'openai' | 'openai_compatible';

export interface AIProfileConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  textModel?: string;
  modelsPath?: string;
  chatPath?: string;
  inputFormat?: 'data_url' | 'bytes' | 'base64' | 'image_url';
  allowedHosts?: string[];
  timeoutMs?: number;
  maxTokens?: number;
  priceVersion?: string;
  promptPriceMinor?: number;
  completionPriceMinor?: number;
  currency?: string;
  priceTable?: DeepSeekPriceTableEntry[];
}

export interface AIProfileInput {
  name: string;
  provider: AIProfileProvider;
  config: AIProfileConfig;
  clearApiKey?: boolean;
}

interface ProfileSecretRow {
  id: string;
  name: string;
  provider: AIProfileProvider;
  revision_id: string;
  revision: number;
  encrypted_config: string;
  probe_result_json?: string | null;
  created_at?: string;
  updated_at?: string;
  active?: number;
  activated_revision_id?: string | null;
}

export function ensureDefaultAIProfile(): void {
  const db = getDb();
  if (profileCount(db) > 0) return;

  const legacy = readLegacyConfig(db);
  const hasEnvironment = ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','DEEPSEEK_VISION_MODEL'].some((name) => Boolean(process.env[name]?.trim()));
  if (!hasEnvironment && !Object.values(legacy).some((value) => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '')) return;
  const config = { ...environmentBootstrapConfig(), ...legacy };
  const now = new Date().toISOString();
  const profileId = randomUUID();
  const revisionId = randomUUID();
  const encrypted = encryptJson(config);

  withTransaction((transaction) => {
    if (profileCount(transaction) > 0) return;
    transaction.prepare(`INSERT INTO ai_profiles
      (id, name, provider, active_revision_id, created_at, updated_at)
      VALUES (?, ?, 'deepseek', ?, ?, ?)`).run(profileId, '默认 DeepSeek', revisionId, now, now);
    transaction.prepare(`INSERT INTO ai_profile_revisions
      (id, profile_id, revision, encrypted_config, created_at)
      VALUES (?, ?, 1, ?, ?)`).run(revisionId, profileId, encrypted, now);
    transaction.prepare(`INSERT INTO active_ai_profile
      (singleton, profile_id, revision_id, updated_at) VALUES (1, ?, ?, ?)`)
      .run(profileId, revisionId, now);
    bindLegacyJobs(transaction, profileId, revisionId, encrypted);
  });
}

export function listAIProfiles() {
  ensureDefaultAIProfile();
  const rows = getDb().prepare(`${profileSelect()} WHERE p.deleted_at IS NULL ORDER BY p.created_at`).all() as ProfileSecretRow[];
  return rows.map(publicProfile);
}

export function getAIProfileSecret(id: string) {
  ensureDefaultAIProfile();
  const row = getDb().prepare(`${profileSelect()} WHERE p.id = ? AND p.deleted_at IS NULL`).get(id) as ProfileSecretRow | undefined;
  if (!row) throw notFound();
  return secretProfile(row);
}

export function getActiveAIProfileSecret() {
  ensureDefaultAIProfile();
  const row = getDb().prepare(`SELECT p.id, p.name, p.provider, p.created_at, p.updated_at,
    r.id revision_id, r.revision, r.encrypted_config, r.probe_result_json, 1 active
    FROM active_ai_profile a
    JOIN ai_profiles p ON p.id = a.profile_id
    JOIN ai_profile_revisions r ON r.id = a.revision_id
    WHERE a.singleton = 1 AND p.deleted_at IS NULL`).get() as ProfileSecretRow | undefined;
  return row ? secretProfile(row) : null;
}

export function saveAIProfile(input: AIProfileInput, id?: string) {
  const now = new Date().toISOString();
  const profileId = id || randomUUID();
  withTransaction((db) => {
    const previous = id
      ? db.prepare(`SELECT r.encrypted_config, p.provider
          FROM ai_profiles p JOIN ai_profile_revisions r ON r.id = p.active_revision_id
          WHERE p.id = ? AND p.deleted_at IS NULL`).get(id) as { encrypted_config: string; provider: AIProfileProvider } | undefined
      : undefined;
    if (id && !previous) throw notFound();
    if (previous && previous.provider !== input.provider) throw appError('已有档案不能更改供应商类型，请复制为新档案', 'AI_PROFILE_PROVIDER_IMMUTABLE', 409);

    const prior = previous ? decryptJson<AIProfileConfig>(previous.encrypted_config) : {};
    const config = normalizeConfig({ ...prior, ...input.config });
    if (!input.config.apiKey) config.apiKey = input.clearApiKey ? undefined : prior.apiKey;
    const revision = Number((db.prepare('SELECT MAX(revision) value FROM ai_profile_revisions WHERE profile_id = ?')
      .get(profileId) as { value?: number } | undefined)?.value || 0) + 1;
    const revisionId = randomUUID();

    if (!id) {
      db.prepare(`INSERT INTO ai_profiles (id, name, provider, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run(profileId, input.name, input.provider, now, now);
    } else {
      db.prepare('UPDATE ai_profiles SET name = ?, provider = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.provider, now, profileId);
    }
    db.prepare(`INSERT INTO ai_profile_revisions
      (id, profile_id, revision, encrypted_config, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(revisionId, profileId, revision, encryptJson(config), now);
    db.prepare('UPDATE ai_profiles SET active_revision_id = ? WHERE id = ?').run(revisionId, profileId);
  });
  return listAIProfiles().find((profile) => profile.id === profileId)!;
}

export function copyAIProfile(id: string, name?: string) {
  const source = getAIProfileSecret(id);
  return saveAIProfile({
    name: name?.trim() || `${source.name} 副本`,
    provider: source.provider,
    config: source.config,
  });
}

export function activateAIProfile(id: string) {
  withTransaction((db) => {
    const row = db.prepare('SELECT active_revision_id FROM ai_profiles WHERE id = ? AND deleted_at IS NULL').get(id) as
      | { active_revision_id: string }
      | undefined;
    if (!row) throw notFound();
    db.prepare(`INSERT INTO active_ai_profile (singleton, profile_id, revision_id, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET profile_id = excluded.profile_id,
        revision_id = excluded.revision_id, updated_at = excluded.updated_at`)
      .run(id, row.active_revision_id, new Date().toISOString());
  });
  return listAIProfiles().find((profile) => profile.id === id)!;
}

export function deleteAIProfile(id: string): void {
  withTransaction((db) => {
    if (db.prepare('SELECT 1 FROM active_ai_profile WHERE profile_id = ?').get(id)) {
      throw appError('当前激活档案不能删除', 'AI_PROFILE_ACTIVE', 409);
    }
    const now = new Date().toISOString();
    const result = db.prepare('UPDATE ai_profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id);
    if (result.changes !== 1) throw notFound();
  });
}

export function saveAIProfileProbe(id: string, result: ProviderCapabilities): void {
  const profile = getAIProfileSecret(id);
  const safeResult = {
    provider: result.provider,
    available: result.available,
    vision: result.vision,
    acceptsDataUrl: result.acceptsDataUrl,
    inputFormat: result.inputFormat,
    model: result.model,
    reason: result.reason,
    checkedAt: new Date().toISOString(),
  };
  withTransaction((db) => db.prepare('UPDATE ai_profile_revisions SET probe_result_json = ? WHERE id = ?')
    .run(JSON.stringify(safeResult), profile.revisionId));
}

export function encryptedActiveJobSnapshot() {
  const active = getActiveAIProfileSecret();
  return active ? {
    provider: active.provider,
    profileId: active.id,
    revisionId: active.revisionId,
    profileName: active.name,
    model: active.config.model,
    revision: active.revision,
    versionFingerprint: createHash('sha256').update(active.revisionId).digest('hex').slice(0, 16),
    snapshot: encryptJson(active.config),
  } : null;
}

function profileSelect(): string {
  return `SELECT p.id, p.name, p.provider, p.created_at, p.updated_at,
    r.id revision_id, r.revision, r.encrypted_config, r.probe_result_json,
    CASE WHEN a.profile_id = p.id THEN 1 ELSE 0 END active,
    a.revision_id activated_revision_id
    FROM ai_profiles p
    JOIN ai_profile_revisions r ON r.id = p.active_revision_id
    LEFT JOIN active_ai_profile a ON a.singleton = 1`;
}

function publicProfile(row: ProfileSecretRow) {
  const config = decryptJson<AIProfileConfig>(row.encrypted_config);
  let lastProbe: (ProviderCapabilities & { checkedAt?: string }) | null = null;
  try { lastProbe = row.probe_result_json ? JSON.parse(row.probe_result_json) : null; } catch { lastProbe = null; }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    revisionId: row.revision_id,
    revision: row.revision,
    active: Boolean(row.active),
    activeRevisionId: row.activated_revision_id || null,
    hasPendingRevision: Boolean(row.active && row.activated_revision_id !== row.revision_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: {
      ...config,
      apiKey: undefined,
      apiKeyConfigured: Boolean(config.apiKey),
      apiKeyHint: maskSecret(config.apiKey),
    },
    lastProbe,
  };
}

function secretProfile(row: ProfileSecretRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    revisionId: row.revision_id,
    revision: row.revision,
    config: decryptJson<AIProfileConfig>(row.encrypted_config),
  };
}

function normalizeConfig(config: AIProfileConfig): AIProfileConfig {
  return {
    ...config,
    allowedHosts: [...new Set((config.allowedHosts || []).map((host) => host.trim().toLowerCase()).filter(Boolean))],
    priceTable: Array.isArray(config.priceTable) ? config.priceTable.slice(0, 128) : [],
  };
}

function environmentBootstrapConfig(): AIProfileConfig {
  return normalizeConfig({
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || undefined,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/v1',
    model: (process.env.DEEPSEEK_MODEL || process.env.DEEPSEEK_VISION_MODEL)?.trim() || undefined,
    textModel: process.env.DEEPSEEK_TEXT_MODEL?.trim() || undefined,
    modelsPath: process.env.DEEPSEEK_MODELS_PATH?.trim() || '/models',
    chatPath: process.env.DEEPSEEK_CHAT_PATH?.trim() || '/chat/completions',
    inputFormat: (process.env.DEEPSEEK_INPUT_FORMAT?.trim() as AIProfileConfig['inputFormat']) || 'data_url',
    allowedHosts: process.env.DEEPSEEK_ALLOWED_HOSTS?.split(',').map((host) => host.trim()) || ['api.deepseek.com'],
    timeoutMs: envInteger('DEEPSEEK_TIMEOUT_MS'),
    maxTokens: envInteger('DEEPSEEK_MAX_TOKENS'),
    priceVersion: process.env.DEEPSEEK_PRICE_VERSION?.trim() || undefined,
    promptPriceMinor: envInteger('DEEPSEEK_PROMPT_PRICE_MINOR'),
    completionPriceMinor: envInteger('DEEPSEEK_COMPLETION_PRICE_MINOR'),
    currency: process.env.DEEPSEEK_CURRENCY?.trim() || undefined,
  });
}

function readLegacyConfig(db: SqliteDatabase): AIProfileConfig {
  const row = db.prepare("SELECT value, is_encrypted FROM app_settings WHERE key = 'deepseek.config'").get() as
    | { value: string; is_encrypted: number }
    | undefined;
  if (!row) return {};
  try {
    return normalizeConfig(row.is_encrypted === 1
      ? decryptJson<AIProfileConfig>(row.value)
      : JSON.parse(row.value) as AIProfileConfig);
  } catch {
    return {};
  }
}

function bindLegacyJobs(db: SqliteDatabase, profileId: string, revisionId: string, encrypted: string): void {
  db.prepare(`UPDATE import_jobs SET ai_profile_id = ?, ai_profile_revision_id = ?, ai_config_snapshot = ?
    WHERE status IN ('queued', 'running', 'paused', 'cancelling') AND ai_profile_revision_id IS NULL`)
    .run(profileId, revisionId, encrypted);
  const row = db.prepare('SELECT state_json FROM pipeline_state WHERE id = 1').get() as { state_json: string } | undefined;
  if (!row) return;
  try {
    const state = JSON.parse(row.state_json) as { jobs?: Record<string, Record<string, unknown>> };
    let changed = false;
    for (const job of Object.values(state.jobs || {})) {
      if (!['queued', 'running', 'paused', 'cancelling'].includes(String(job.status)) || job.aiProfileRevisionId) continue;
      job.aiProfileId = profileId;
      job.aiProfileRevisionId = revisionId;
      job.aiConfigSnapshot = encrypted;
      changed = true;
    }
    if (changed) db.prepare("UPDATE pipeline_state SET state_json = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = 1")
      .run(JSON.stringify(state));
  } catch {
    // A corrupt pipeline snapshot is handled by the pipeline repository; do not hide it here.
  }
}

function profileCount(db: SqliteDatabase): number {
  return Number((db.prepare('SELECT COUNT(*) count FROM ai_profiles WHERE deleted_at IS NULL').get() as { count: number }).count);
}

function envInteger(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function notFound() {
  return appError('AI 配置档案不存在', 'AI_PROFILE_NOT_FOUND', 404);
}

function appError(message: string, code: string, status: number) {
  return Object.assign(new Error(message), { code, status });
}
