import { getDatabaseGeneration, getDb } from "../db";
import { getDeepSeekConfig, resolveDeepSeekPricing } from "../deepseek-config";
import { DeepSeekVisionProvider, MockVisionProvider, VisionProvider } from "../ai/provider";
import { TokenLedger } from "../budget/ledger";
import { SqliteBudgetStateBackend } from "../budget/repository";
import { ChunkedUploadService } from "../ingest/chunked-upload";
import { ImportJobRunner } from "./runner";
import { CatalogCandidateService } from "../catalog/pipeline-candidate";
import { SqliteStateBackend } from "./repository";
import { PipelineStore } from "./store";
import { assertNotInMaintenance, withWriteLease } from "../maintenance";
import { encryptedActiveJobSnapshot } from "../ai-profiles";

export interface PipelineRuntime {
  store: PipelineStore;
  ledger: TokenLedger;
  uploads: ChunkedUploadService;
  runner: ImportJobRunner;
  providers: Record<string, VisionProvider>;
  catalog?: CatalogCandidateService;
  /** Internal guard used to invalidate SQLite-backed repositories after a
   * cross-process restore swaps the database file. */
  databaseGeneration?: number;
}

let singleton: PipelineRuntime | undefined;

/** Runtime used by API routes and the standalone worker. SQLite is the default
 * durable backend; setting PIPELINE_USE_FILE_STORE=1 is an explicit local/test
 * fallback only. */
export function getPipelineRuntime(): PipelineRuntime {
  const useFile = process.env.PIPELINE_USE_FILE_STORE === "1";
  if (useFile && singleton) return singleton;
  const db = useFile ? undefined : getDb();
  const generation = useFile ? undefined : getDatabaseGeneration();
  if (singleton && singleton.databaseGeneration === generation) return singleton;
  const store = useFile ? new PipelineStore() : new PipelineStore(process.env.PIPELINE_STATE_FILE, new SqliteStateBackend(db!));
  const dailyTokenLimit = parseInteger(process.env.PIPELINE_DAILY_TOKEN_LIMIT || process.env.AI_DAILY_TOKEN_LIMIT, 2_000_000);
  const perTaskTokenLimit = parseInteger(process.env.PIPELINE_TASK_TOKEN_LIMIT || process.env.AI_JOB_TOKEN_LIMIT, 100_000);
  const costPerTokenMinor = parseInteger(process.env.PIPELINE_COST_PER_TOKEN_MINOR, 0);
  const deepseekConfig = useFile ? { baseUrl: null, model: null, textModel: null, apiKey: null, inputFormat: null, allowedHosts: [] as string[], modelsPath: null, chatPath: null, timeoutMs: null, maxTokens: null, priceVersion: null, promptPriceMinor: null, completionPriceMinor: null, currency: null } : getDeepSeekConfig();
  if (!useFile) {
    const snapshot=encryptedActiveJobSnapshot();
    if(snapshot) for(const job of store.listJobs(500)) if(!job.aiConfigSnapshot&&['queued','running','paused'].includes(job.status)) store.putJob({...job,provider:snapshot.provider,aiProfileId:snapshot.profileId,aiProfileRevisionId:snapshot.revisionId,aiProfileName:snapshot.profileName,aiModel:snapshot.model,aiProfileRevision:snapshot.revision,aiVersionFingerprint:snapshot.versionFingerprint,aiConfigSnapshot:snapshot.snapshot});
  }
  const pricing = useFile ? { priceVersion: null, promptPriceMinor: null, completionPriceMinor: null, currency: null } : resolveDeepSeekPricing(deepseekConfig.model);
  const ledger = useFile ? new TokenLedger(undefined, {
    dailyTokenLimit, perTaskTokenLimit, costPerTokenMinor,
    promptCostPerTokenMinor: pricing.promptPriceMinor ?? costPerTokenMinor,
    completionCostPerTokenMinor: pricing.completionPriceMinor ?? costPerTokenMinor,
    priceVersion: pricing.priceVersion || undefined,
    currency: pricing.currency || undefined,
  }) : new TokenLedger(undefined, {
    dailyTokenLimit, perTaskTokenLimit, costPerTokenMinor,
    promptCostPerTokenMinor: pricing.promptPriceMinor ?? costPerTokenMinor,
    completionCostPerTokenMinor: pricing.completionPriceMinor ?? costPerTokenMinor,
    priceVersion: pricing.priceVersion || undefined,
    currency: pricing.currency || undefined,
  }, new SqliteBudgetStateBackend(db!));
  const uploads = new ChunkedUploadService(store, process.env.PIPELINE_MEDIA_ROOT, {
    maxUploadBytes: parseLimit(process.env.MAX_ZIP_BYTES, 4 * 1024 * 1024 * 1024),
    maxChunkBytes: parseLimit(process.env.MAX_CHUNK_BYTES, 16 * 1024 * 1024),
    maxChunks: parseLimit(process.env.MAX_UPLOAD_CHUNKS, 20_000),
    maxImagePixels: parseLimit(process.env.MAX_IMAGE_PIXELS, 40_000_000),
    maxImageBytes: parseLimit(process.env.MAX_IMAGE_BYTES, 50 * 1024 * 1024),
  }, useFile ? undefined : withWriteLease);
  const providers: Record<string, VisionProvider> = {
    mock: new MockVisionProvider({ available: process.env.PIPELINE_MOCK_DISABLED !== "1" }),
    deepseek: (() => {
      const config = deepseekConfig;
      return new DeepSeekVisionProvider({
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        apiKey: config.apiKey || undefined,
        inputFormat: (config.inputFormat as 'data_url' | 'bytes' | 'base64' | 'image_url' | undefined),
        allowedHosts: config.allowedHosts,
        modelsPath: config.modelsPath || undefined,
        chatPath: config.chatPath || undefined,
        timeoutMs: config.timeoutMs || undefined,
        maxTokens: config.maxTokens || undefined,
        requireAllowlist: process.env.NODE_ENV === 'production',
        visionConfirmed: process.env.DEEPSEEK_VISION_CONFIRMED === "true",
      });
    })(),
  };
  providers.openai = providers.deepseek;
  providers.openai_compatible = providers.deepseek;
  const catalog = useFile ? undefined : new CatalogCandidateService(db!);
  const runner = new ImportJobRunner(store, ledger, providers, {
    derivativeRoot: process.env.PIPELINE_MEDIA_ROOT,
    // The SQLite runtime is production-gated; the explicit file-store
    // fallback remains usable in isolated tests/dev without requiring a native
    // SQLite maintenance table/driver.
    assertWritable: useFile ? undefined : assertNotInMaintenance,
  }, catalog);
  singleton = { store, ledger, uploads, runner, providers, catalog, databaseGeneration: generation };
  return singleton;
}

/** Drop cached stores after a database switch (restore). */
export function resetPipelineRuntime(): void { singleton = undefined; }

/** Backwards-compatible test helper name. */
export function resetPipelineRuntimeForTests(): void { resetPipelineRuntime(); }

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
