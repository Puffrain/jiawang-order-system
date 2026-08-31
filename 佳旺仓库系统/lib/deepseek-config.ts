import { decryptJson, encryptJson, maskSecret } from '@/lib/crypto';
import { getDb, withTransaction } from '@/lib/db';
import { randomUUID } from 'node:crypto';
import type { DeepSeekConfigInput, DeepSeekConfigPublic, DeepSeekPriceTableEntry } from '@/lib/contracts/platform';
import type { ProviderCapabilities } from '@/lib/contracts/pipeline';
import { activateAIProfile, ensureDefaultAIProfile, getActiveAIProfileSecret, saveAIProfile, type AIProfileConfig } from '@/lib/ai-profiles';

const SETTING_KEY = 'deepseek.config';
const CAPABILITIES_KEY = 'deepseek.capabilities';

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  textModel?: string;
  modelsPath?: string;
  chatPath?: string;
  inputFormat?: string;
  allowedHosts?: string[];
  timeoutMs?: number;
  maxTokens?: number;
  priceVersion?: string;
  promptPriceMinor?: number;
  completionPriceMinor?: number;
  currency?: string;
  priceTable?: DeepSeekPriceTableEntry[];
}

export interface EffectiveDeepSeekConfig {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  textModel: string | null;
  modelsPath: string | null;
  chatPath: string | null;
  inputFormat: string | null;
  allowedHosts: string[];
  timeoutMs: number | null;
  maxTokens: number | null;
  priceVersion: string | null;
  promptPriceMinor: number | null;
  completionPriceMinor: number | null;
  currency: string | null;
  priceTable: DeepSeekPriceTableEntry[];
  source: 'environment' | 'database' | 'none';
}

function readStored(): StoredConfig {
  const row = getDb().prepare('SELECT value, is_encrypted FROM app_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string; is_encrypted: number }
    | undefined;
  if (!row) return {};
  try {
    if (row.is_encrypted !== 1) return JSON.parse(row.value) as StoredConfig;
    return decryptJson<StoredConfig>(row.value);
  } catch {
    // A missing/rotated APP_MASTER_KEY must not crash health or login APIs.
    return {};
  }
}

function environmentConfig(): StoredConfig {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || undefined,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || undefined,
    model: process.env.DEEPSEEK_MODEL?.trim() || process.env.DEEPSEEK_VISION_MODEL?.trim() || undefined,
    textModel: process.env.DEEPSEEK_TEXT_MODEL?.trim() || undefined,
    modelsPath: process.env.DEEPSEEK_MODELS_PATH?.trim() || undefined,
    chatPath: process.env.DEEPSEEK_CHAT_PATH?.trim() || undefined,
    inputFormat: process.env.DEEPSEEK_INPUT_FORMAT?.trim() || process.env.DEEPSEEK_INPUT_MODE?.trim() || undefined,
    allowedHosts: process.env.DEEPSEEK_ALLOWED_HOSTS?.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) || undefined,
    timeoutMs: parseEnvInteger('DEEPSEEK_TIMEOUT_MS'),
    maxTokens: parseEnvInteger('DEEPSEEK_MAX_TOKENS'),
    priceVersion: process.env.DEEPSEEK_PRICE_VERSION?.trim() || undefined,
    promptPriceMinor: parseEnvInteger('DEEPSEEK_PROMPT_PRICE_MINOR'),
    completionPriceMinor: parseEnvInteger('DEEPSEEK_COMPLETION_PRICE_MINOR'),
    currency: process.env.DEEPSEEK_CURRENCY?.trim() || undefined,
    priceTable: parsePriceTableEnv(process.env.DEEPSEEK_PRICE_TABLE),
  };
}

export function getDeepSeekConfig(): EffectiveDeepSeekConfig {
  ensureDefaultAIProfile();
  const active = getActiveAIProfileSecret();
  if (active) {
    const c = active.config;
    return { apiKey:c.apiKey??null,baseUrl:c.baseUrl??null,model:c.model??null,textModel:c.textModel??null,modelsPath:c.modelsPath??null,chatPath:c.chatPath??null,inputFormat:c.inputFormat??null,allowedHosts:c.allowedHosts??[],timeoutMs:c.timeoutMs??null,maxTokens:c.maxTokens??null,priceVersion:c.priceVersion??null,promptPriceMinor:c.promptPriceMinor??null,completionPriceMinor:c.completionPriceMinor??null,currency:c.currency??null,priceTable:normalizePriceTable(c.priceTable),source:'database' };
  }
  const stored = readStored();
  const env = environmentConfig();
  const effective: StoredConfig = {
    apiKey: env.apiKey ?? stored.apiKey,
    baseUrl: env.baseUrl ?? stored.baseUrl,
    model: env.model ?? stored.model,
    textModel: env.textModel ?? stored.textModel,
    modelsPath: env.modelsPath ?? stored.modelsPath,
    chatPath: env.chatPath ?? stored.chatPath,
    inputFormat: env.inputFormat ?? stored.inputFormat,
    allowedHosts: env.allowedHosts ?? stored.allowedHosts,
    timeoutMs: env.timeoutMs ?? stored.timeoutMs,
    maxTokens: env.maxTokens ?? stored.maxTokens,
    priceVersion: env.priceVersion ?? stored.priceVersion,
    promptPriceMinor: env.promptPriceMinor ?? stored.promptPriceMinor,
    completionPriceMinor: env.completionPriceMinor ?? stored.completionPriceMinor,
    currency: env.currency ?? stored.currency,
    priceTable: env.priceTable ?? stored.priceTable,
  };
  const source: EffectiveDeepSeekConfig['source'] = Object.values(env).some(Boolean)
    ? 'environment'
    : Object.values(stored).some(Boolean)
      ? 'database'
      : 'none';
  return {
    apiKey: effective.apiKey ?? null,
    baseUrl: effective.baseUrl ?? null,
    model: effective.model ?? null,
    textModel: effective.textModel ?? null,
    modelsPath: effective.modelsPath ?? null,
    chatPath: effective.chatPath ?? null,
    inputFormat: effective.inputFormat ?? null,
    allowedHosts: effective.allowedHosts ?? [],
    timeoutMs: effective.timeoutMs ?? null,
    maxTokens: effective.maxTokens ?? null,
    priceVersion: effective.priceVersion ?? null,
    promptPriceMinor: effective.promptPriceMinor ?? null,
    completionPriceMinor: effective.completionPriceMinor ?? null,
    currency: effective.currency ?? null,
    priceTable: normalizePriceTable(effective.priceTable),
    source
  };
}

/** Resolve the immutable price snapshot that should be attached to a task.
 * Model-specific entries win; a model-less entry is the configured fallback;
 * legacy scalar fields remain supported for existing deployments. */
export function resolveDeepSeekPricing(model?: string | null): {
  priceVersion: string | null;
  promptPriceMinor: number | null;
  completionPriceMinor: number | null;
  currency: string | null;
} {
  const config = getDeepSeekConfig();
  const table = config.priceTable;
  const match = (model && table.find((entry) => entry.model === model)) || table.find((entry) => !entry.model);
  if (match) return {
    priceVersion: match.version,
    promptPriceMinor: match.promptPriceMinor,
    completionPriceMinor: match.completionPriceMinor,
    currency: match.currency,
  };
  return {
    priceVersion: config.priceVersion,
    promptPriceMinor: config.promptPriceMinor,
    completionPriceMinor: config.completionPriceMinor,
    currency: config.currency,
  };
}

export function getPublicDeepSeekConfig(): DeepSeekConfigPublic {
  const config = getDeepSeekConfig();
  return {
    source: config.source,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyHint: maskSecret(config.apiKey),
    baseUrl: config.baseUrl,
    model: config.model,
    textModel: config.textModel,
    modelsPath: config.modelsPath,
    chatPath: config.chatPath,
    inputFormat: config.inputFormat,
    allowedHosts: config.allowedHosts,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    priceVersion: config.priceVersion,
    promptPriceMinor: config.promptPriceMinor,
    completionPriceMinor: config.completionPriceMinor,
    currency: config.currency,
    priceTable: config.priceTable,
  };
}

export function saveDeepSeekConfig(input: DeepSeekConfigInput): DeepSeekConfigPublic {
  const active = getActiveAIProfileSecret();
  if (active) {
    const profile=saveAIProfile({name:active.name,provider:active.provider,config:input as AIProfileConfig},active.id);
    activateAIProfile(profile.id);
    return getPublicDeepSeekConfig();
  }
  const current = readStored();
  const next: StoredConfig = {
    ...current,
    ...(input.apiKey !== undefined && input.apiKey !== '' ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.textModel !== undefined ? { textModel: input.textModel } : {}),
    ...(input.modelsPath !== undefined ? { modelsPath: input.modelsPath } : {}),
    ...(input.chatPath !== undefined ? { chatPath: input.chatPath } : {}),
    ...(input.inputFormat !== undefined ? { inputFormat: input.inputFormat } : {}),
    ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.priceVersion !== undefined ? { priceVersion: input.priceVersion } : {}),
    ...(input.promptPriceMinor !== undefined ? { promptPriceMinor: input.promptPriceMinor } : {}),
    ...(input.completionPriceMinor !== undefined ? { completionPriceMinor: input.completionPriceMinor } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.priceTable !== undefined ? { priceTable: normalizePriceTable(input.priceTable) } : {}),
  };
  const now = new Date().toISOString();
  // Persist the complete object encrypted so a database dump does not expose
  // an API key. APP_MASTER_KEY is deliberately required by encryptJson().
  const table = normalizePriceTable(next.priceTable);
  withTransaction((db) => {
    // Persist the complete object encrypted so a database dump does not expose
    // an API key. APP_MASTER_KEY is deliberately required by encryptJson().
    db.prepare(
      `INSERT INTO app_settings (key, value, is_encrypted, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_encrypted = 1, updated_at = excluded.updated_at`
    ).run(SETTING_KEY, encryptJson(next), now);
    if (next.priceVersion && next.currency && Number.isSafeInteger(next.promptPriceMinor) && Number.isSafeInteger(next.completionPriceMinor)) {
      // Keep an immutable pricing snapshot so later settlements can explain
      // the exact integer rates used at reservation time.
      db.prepare(`INSERT OR IGNORE INTO pricing_versions
        (id, provider, model, version, currency, prompt_price_minor, completion_price_minor, created_at)
        VALUES (?, 'deepseek', ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), next.model || null, next.priceVersion, next.currency, next.promptPriceMinor, next.completionPriceMinor, now);
    }
    for (const entry of table) {
      db.prepare(`INSERT OR IGNORE INTO pricing_versions
        (id, provider, model, version, currency, prompt_price_minor, completion_price_minor, created_at)
        VALUES (?, 'deepseek', ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), entry.model || null, entry.version, entry.currency,
        entry.promptPriceMinor, entry.completionPriceMinor, now,
      );
    }
    // A configuration change invalidates the last probe.
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(CAPABILITIES_KEY);
  });
  return getPublicDeepSeekConfig();
}

/** Return a defensive, bounded copy. Price tables are configuration, not a
 * free-form JSON sink; malformed entries are discarded before persistence or
 * exposure to the runtime. */
function normalizePriceTable(value: unknown): DeepSeekPriceTableEntry[] {
  if (!Array.isArray(value)) return [];
  const result: DeepSeekPriceTableEntry[] = [];
  for (const entry of value.slice(0, 128)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as Partial<DeepSeekPriceTableEntry>;
    const version = typeof candidate.version === 'string' ? candidate.version.trim().slice(0, 128) : '';
    const currency = typeof candidate.currency === 'string' ? candidate.currency.trim().toUpperCase() : '';
    const prompt = candidate.promptPriceMinor;
    const completion = candidate.completionPriceMinor;
    if (!version || !/^[A-Z]{3}$/.test(currency)
      || typeof prompt !== 'number' || !Number.isSafeInteger(prompt) || prompt < 0
      || typeof completion !== 'number' || !Number.isSafeInteger(completion) || completion < 0) continue;
    const model = candidate.model == null || candidate.model === '' ? null : String(candidate.model).trim().slice(0, 256);
    result.push({ model, version, currency, promptPriceMinor: prompt, completionPriceMinor: completion });
  }
  return result;
}

function parsePriceTableEnv(value: string | undefined): DeepSeekPriceTableEntry[] | undefined {
  if (!value?.trim()) return undefined;
  try { return normalizePriceTable(JSON.parse(value)); }
  catch { return undefined; }
}

function parseEnvInteger(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function getCachedDeepSeekCapabilities(): ProviderCapabilities | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(CAPABILITIES_KEY) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    const value = JSON.parse(row.value) as ProviderCapabilities & { checkedAt?: string };
    if (typeof value.provider !== 'string' || typeof value.available !== 'boolean' || typeof value.vision !== 'boolean') return null;
    return value;
  } catch { return null; }
}

export function saveDeepSeekCapabilities(value: ProviderCapabilities): void {
  const payload = JSON.stringify({ ...value, checkedAt: new Date().toISOString() });
  withTransaction((db) => db.prepare(`INSERT INTO app_settings (key, value, is_encrypted, updated_at) VALUES (?, ?, 0, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_encrypted = 0, updated_at = excluded.updated_at`).run(CAPABILITIES_KEY, payload, new Date().toISOString()));
}
