import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AssetRecord, ImportItem, ImportJob, PipelineError, VisionInput, VisionResult } from "../contracts/pipeline";
import { deriveImage } from "../ingest/image-derivative";
import { extractSafeZip, extractSafeZipFile } from "../ingest/zip-safe";
import { VisionProvider, AIProviderError, DeepSeekVisionProvider } from "../ai/provider";
import { decryptJson } from "../crypto";
import type { AIProfileConfig } from "../ai-profiles";
import { PipelineStore, pipelineStoreError } from "./store";
import { BudgetError, TokenLedger } from "../budget/ledger";
import type { CatalogCandidateService } from "../catalog/pipeline-candidate";
import { getProduct } from "../catalog-repository";

export interface RunnerOptions {
  owner?: string;
  leaseTtlMs?: number;
  estimatedTokensPerItem?: number;
  maxImagePixels?: number;
  derivativeRoot?: string;
  /** Keep successful provider output in review until a human publishes it. */
  requireReview?: boolean;
  /** Runtime-owned write gate. Omitted by isolated/file-store tests. */
  assertWritable?: () => void;
}

export type ProviderFactory = VisionProvider | (() => VisionProvider);

const PROVIDER_ATTEMPTED_KEY = "__providerAttempted";
const PROVIDER_BUDGET_TASK_KEY = "__budgetTaskId";

export function catalogAiRunId(itemId: string, attempts: number, executionTaskId: string, rerunTaskMarker?: string): string {
  const generation = rerunTaskMarker ? `${rerunTaskMarker}:ai` : `${executionTaskId}:attempt:${attempts}`;
  return `${generation}:item:${itemId}`;
}

export function catalogProjectionDiagnostic(error: unknown): { errorClass: "coded" | "error" | "unknown"; errorCode?: string } {
  const errorClass = isErrorWithCode(error) ? "coded" : error instanceof Error ? "error" : "unknown";
  const errorCode = isErrorWithCode(error) && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  return errorCode ? { errorClass, errorCode } : { errorClass };
}

export interface CreateImportJobOptions {
  provider?: string;
  estimatedTokensPerItem?: number;
  zipLimits?: Parameters<typeof extractSafeZip>[2];
  /** Defer ZIP expansion to the persistent worker instead of the web request. */
  deferPreparation?: boolean;
  aiProfileId?: string;
  aiProfileRevisionId?: string;
  aiProfileName?: string;
  aiModel?: string;
  aiProfileRevision?: number;
  aiVersionFingerprint?: string;
  aiConfigSnapshot?: string;
}

/** Durable, lease-based import runner. One runner instance may be restarted safely. */
export class ImportJobRunner {
  readonly owner: string;
  readonly leaseTtlMs: number;
  readonly estimatedTokensPerItem: number;
  readonly derivativeRoot: string;
  readonly requireReview: boolean;
  readonly catalog?: CatalogCandidateService;
  private readonly assertWritable?: () => void;
  private readonly providers = new Map<string, ProviderFactory>();

  constructor(readonly store: PipelineStore, readonly ledger: TokenLedger, providers: Record<string, ProviderFactory> = {}, options: RunnerOptions = {}, catalog?: CatalogCandidateService) {
    this.owner = options.owner || `${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = Math.max(1_000, Math.min(options.leaseTtlMs ?? 60_000, 24 * 60 * 60 * 1_000));
    this.estimatedTokensPerItem = Number.isSafeInteger(options.estimatedTokensPerItem ?? 1_024) && (options.estimatedTokensPerItem ?? 1_024) > 0 ? options.estimatedTokensPerItem ?? 1_024 : 1_024;
    this.derivativeRoot = path.resolve(options.derivativeRoot || process.env.PIPELINE_MEDIA_ROOT || path.join(process.cwd(), "data", "media"));
    this.requireReview = options.requireReview !== false;
    this.assertWritable = options.assertWritable;
    this.catalog = catalog;
    for (const [name, provider] of Object.entries(providers)) this.providers.set(name, provider);
  }

  registerProvider(name: string, provider: ProviderFactory): void {
    if (!name || !/^[a-z0-9._-]+$/i.test(name)) throw new Error("Provider name is invalid");
    this.providers.set(name, provider);
  }

  providerNames(): string[] { return [...this.providers.keys()]; }

  /** Create a job and source items from a completed upload. */
  async createFromUpload(uploadId: string, options: CreateImportJobOptions = {}): Promise<ImportJob> {
    const upload = this.store.getUpload(uploadId);
    if (!upload || upload.status !== "completed" || !upload.originalAssetId) throw pipelineStoreError("UPLOAD_NOT_COMPLETED", "Upload must be completed before creating an import job");
    const source = this.store.getAsset(upload.originalAssetId);
    if (!source) throw pipelineStoreError("ASSET_NOT_FOUND", "Upload source asset is missing");
    const provider = options.provider || "mock";
    if (!this.providers.has(provider)) throw pipelineStoreError("PROVIDER_NOT_FOUND", `Unknown provider ${provider}`);
    const job = this.store.createJob({ sourceAssetId: source.id, uploadId, itemIds: [], totalItems: 0, provider, reservedTokens: 0, estimatedCostMinor: 0, aiProfileId: options.aiProfileId, aiProfileRevisionId: options.aiProfileRevisionId, aiProfileName: options.aiProfileName, aiModel: options.aiModel, aiProfileRevision: options.aiProfileRevision, aiVersionFingerprint: options.aiVersionFingerprint, aiConfigSnapshot: options.aiConfigSnapshot });
    try {
      if (options.deferPreparation && source.mimeType === "application/zip") return this.store.getJob(job.id)!;
      const assets = source.mimeType === "application/zip" ? await this.expandZip(source, options.zipLimits) : [source];
      if (!assets.length) throw pipelineStoreError("NO_IMAGES", "Upload contains no supported images");
      for (const asset of assets) this.store.createItem({ jobId: job.id, sourceAssetId: asset.id, manualRequired: false });
      const refreshed = this.store.getJob(job.id)!;
      return refreshed;
    } catch (error) {
      this.store.transitionJob(job.id, "failed", classifyError(error, "validation"));
      throw error;
    }
  }

  /** Run queued work until the job reaches a durable terminal/paused state. */
  async run(jobId: string): Promise<ImportJob> {
    this.assertWritable?.();
    const checkpoint = this.store.getJob(jobId);
    if (!checkpoint) throw pipelineStoreError("JOB_NOT_FOUND", "Unknown job");
    // An explicit pause is a fencing checkpoint. The control API must resume
    // it first; accepting a direct run request here would let an old browser
    // tab silently bypass the operator's pause decision.
    if (checkpoint.status === "paused" && checkpoint.error?.code === "PAUSED_MANUAL") {
      throw pipelineStoreError("JOB_PAUSED", "任务已人工暂停，请先恢复任务");
    }
    let claimed = this.store.acquireJobLease(jobId, this.owner, this.leaseTtlMs);
    if (["succeeded", "failed", "cancelled"].includes(claimed.status)) return claimed;
    // A retry records a durable refund marker before changing the job
    // generation. Reconcile it before reserving the new generation; replay is
    // safe because TokenLedger.refund() is idempotent.
    if (claimed.pendingBudgetRefund) {
      try {
        claimed = settlePendingBudgetRefund(this.store, this.ledger, claimed);
      } catch (error) {
        const classified = classifyError(error, "budget");
        this.store.transitionJob(jobId, "paused", classified);
        this.store.releaseJobLease(jobId, this.owner);
        return this.store.getJob(jobId)!;
      }
    }
    let provider: VisionProvider;
    try {
      provider = claimed.aiConfigSnapshot ? providerFromSnapshot(claimed.provider, claimed.aiConfigSnapshot) : this.resolveProvider(claimed.provider);
    } catch (error) {
      const classified = classifyError(error, "provider");
      this.store.transitionJob(jobId, "failed", classified);
      this.store.releaseJobLease(jobId, this.owner);
      return this.store.getJob(jobId)!;
    }
    // A deferred ZIP is unpacked only after a worker has acquired the durable
    // lease. This keeps multi-gigabyte extraction and Sharp work out of the
    // Next.js request process.
    if (claimed.totalItems === 0) {
      setJobStage(this.store, jobId, "unpacking");
      try {
        const source = claimed.sourceAssetId ? this.store.getAsset(claimed.sourceAssetId) : undefined;
        if (!source) throw pipelineStoreError("ASSET_NOT_FOUND", "Upload source asset is missing");
        const assets = source.mimeType === "application/zip" ? await this.expandZip(source) : [source];
        if (!assets.length) throw pipelineStoreError("NO_IMAGES", "Upload contains no supported images");
        for (const asset of assets) this.store.createItem({ jobId: claimed.id, sourceAssetId: asset.id, manualRequired: false });
        claimed = this.store.getJob(jobId)!;
        setJobStage(this.store, jobId, "preprocessing");
      } catch (error) {
        this.store.transitionJob(jobId, "failed", classifyError(error, "validation"));
        this.store.releaseJobLease(jobId, this.owner);
        return this.store.getJob(jobId)!;
      }
    }
    setJobStage(this.store, jobId, "classifying");
    // Each execution generation owns a distinct ledger task.  Older snapshots
    // did not persist budgetTaskId, so initialize the legacy key once and keep
    // it on the job for all subsequent calls/restarts.
    const reservationTask = claimed.budgetTaskId || `job:${claimed.id}`;
    if (claimed.budgetTaskId !== reservationTask) {
      claimed.budgetTaskId = reservationTask;
      this.store.putJob(claimed);
    }
    try {
      const activeItems = this.store.listItems(jobId).filter((item) => !["succeeded", "failed", "cancelled", "needs_review"].includes(item.status));
      const expected = Math.max(1, activeItems.length) * this.estimatedTokensPerItem;
      const reservation = this.ledger.reserve(reservationTask, Math.min(expected, this.ledger.limits.perTaskTokenLimit), claimed.aiConfigSnapshot ? pricingFromSnapshot(claimed.aiConfigSnapshot, claimed.provider) : undefined);
      claimed.reservedTokens = reservation.reservedTokens;
      this.store.putJob(claimed);
    } catch (error) {
      const budgetError = classifyError(error, "budget");
      this.store.transitionJob(jobId, "paused", budgetError);
      this.store.releaseJobLease(jobId, this.owner);
      return this.store.getJob(jobId)!;
    }
    try {
      const capability = await provider.probe();
      if (!capability.available || !capability.vision) {
        const error: PipelineError = { code: "PROVIDER_UNAVAILABLE", message: capability.reason || "Vision provider is unavailable", class: "provider", retryable: true };
        for (const item of this.store.listItems(jobId)) {
          if (["succeeded", "failed", "cancelled", "needs_review"].includes(item.status)) continue;
          this.store.transitionItem(item.id, "needs_review", { error, manualRequired: true });
          this.store.event(jobId, "review.required", { itemId: item.id, reason: error.code });
        }
        setJobStage(this.store, jobId, "review_pending");
        this.store.transitionJob(jobId, "paused", error);
        this.store.releaseJobLease(jobId, this.owner);
        return this.store.getJob(jobId)!;
      }
      for (const item of this.store.listItems(jobId)) {
        const live = this.store.getJob(jobId)!;
        if (live.status === "paused") break;
        if (live.cancelRequested || live.status === "cancelling") {
          this.store.requestCancel(jobId);
          this.store.transitionJob(jobId, "cancelled");
          break;
        }
        if (["succeeded", "failed", "cancelled", "needs_review"].includes(item.status)) continue;
        setJobStage(this.store, jobId, "extracting");
        await this.processItem(live, item, provider, reservationTask);
        // Lease renewal is persisted after every item, making a worker crash
        // recoverable even when processing a large ZIP.
        const after = this.store.getJob(jobId)!;
        if (after.status !== "paused" && after.lease?.owner === this.owner) this.store.renewJobLease(jobId, this.owner, this.leaseTtlMs);
      }
      const final = this.store.getJob(jobId)!;
      if (final.status === "paused") {
        // Leave the reservation and unfinished item leases durable for the
        // explicit resume/reconciliation action. Never mark a manually
        // paused job successful in this finalization pass.
        return final;
      } else if (final.status === "cancelling" || final.cancelRequested) {
        this.store.requestCancel(jobId);
        this.store.transitionJob(jobId, "cancelled");
        // A cancelled job may still have made provider calls.  Reconcile when
        // usage is known, but keep cancellation durable if billing is unknown;
        // the held reservation is then available for an operator refund.
        reconcileReservation(this.store, this.ledger, reservationTask, this.store.listItems(jobId), false);
      } else {
        setJobStage(this.store, jobId, "grouping");
        const items = this.store.listItems(jobId);
        const hasActive = items.some((item) => !["succeeded", "failed", "cancelled", "needs_review"].includes(item.status));
        if (hasActive) {
          // An item lease can be held by another worker after a crash/restart.
          // Do not leave the job in `running` with no lease: requeue it for the
          // next poll and let the item lease arbitrate the concurrent retry.
          if (final.status === "running") this.store.transitionJob(jobId, "queued");
        } else {
          // A job with unknown usage pauses in reconcile; known usage settles
          // before we publish a terminal job status.  This ordering prevents a
          // successful status from masking an unresolved billing outcome.
           const usagePaused = reconcileReservation(this.store, this.ledger, reservationTask, items, true);
          if (!usagePaused) {
            // Every failed item is a hard job failure.  `manualRequired` is a
            // routing hint for provider/budget review items, not a reason to
            // report a job containing failed work as succeeded.
            const hasHardFailure = items.some((item) => item.status === "failed");
            setJobStage(this.store, jobId, hasHardFailure ? "failed" : this.requireReview ? "review_pending" : "completed");
            this.store.transitionJob(jobId, hasHardFailure ? "failed" : "succeeded");
          }
        }
      }
      return this.store.getJob(jobId)!;
    } catch (error) {
      const classified = classifyError(error, "unknown");
      this.store.transitionJob(jobId, classified.class === "budget" ? "paused" : "failed", classified);
      // Keep failed reservations for audit; operators may call refund.
      return this.store.getJob(jobId)!;
    } finally {
      const latest = this.store.getJob(jobId);
      if (latest?.lease?.owner === this.owner) this.store.releaseJobLease(jobId, this.owner);
    }
  }

  async cancel(jobId: string): Promise<ImportJob> {
    const result = this.store.requestCancel(jobId);
    if (result.status === "cancelling") this.store.transitionJob(jobId, "cancelled");
    return this.store.getJob(jobId)!;
  }

  pause(jobId: string, reason?: string): ImportJob {
    this.assertWritable?.();
    return this.store.pauseJob(jobId, reason);
  }

  resume(jobId: string): ImportJob {
    this.assertWritable?.();
    const job = this.store.getJob(jobId);
    if (!job) throw pipelineStoreError("JOB_NOT_FOUND", "Unknown job");
    const task = this.ledger.getTask(job.budgetTaskId || `job:${jobId}`);
    if (task?.status === "paused") {
      throw pipelineStoreError("BUDGET_RECONCILIATION_REQUIRED", "Token 用量尚未完成核对，不能自动重发请求");
    }
    return this.store.resumeJob(jobId);
  }

  retry(jobId: string): ImportJob {
    this.assertWritable?.();
    let before = this.store.getJob(jobId);
    if (!before) throw pipelineStoreError("JOB_NOT_FOUND", "Unknown job");
    if (before.pendingBudgetRefund) before = settlePendingBudgetRefund(this.store, this.ledger, before);
    if (["queued", "running"].includes(before.status) && itemIdFromBudgetTask(before.budgetTaskId)) {
      throw pipelineStoreError("JOB_RETRY_CONFLICT", "An item retry is already queued for this job");
    }
    if (["queued", "running"].includes(before.status) && isWholeJobBudgetTask(before.budgetTaskId) && (before.retryCount || 0) > 0) return before;
    const previousTaskId = before.budgetTaskId || `job:${jobId}`;
    const previousTask = this.ledger.getTask(previousTaskId);
    let refundPreviousReservation = false;
    if (previousTask?.status === "paused") {
      // A paused reservation means the provider may have charged an
      // indeterminate amount. Retrying would risk a double charge; require an
      // explicit reconciliation/refund operation first.
      throw pipelineStoreError("BUDGET_RECONCILIATION_REQUIRED", "Token 用量尚未完成核对，不能自动重试");
    }
    if (previousTask?.status === "reserved") {
      const attempted = this.store.listItems(jobId).some((item) => itemAttemptedForTask(item, previousTaskId));
      if (attempted) {
        throw pipelineStoreError("BUDGET_RECONCILIATION_REQUIRED", "任务可能已产生计费但用量未知，不能自动重试");
      }
      // No provider call was attempted, so returning the untouched reservation
      // is safe and prevents a retry from leaking the old budget hold.
      refundPreviousReservation = true;
    }
    const nextBudgetTaskId = `job:${jobId}:retry:${(before.retryCount || 0) + 1}`;
    const retried = this.store.retryJob(jobId, (item) => {
      if (!item.candidateProductId) return true;
      if (!this.catalog) throw pipelineStoreError("CATALOG_UNAVAILABLE", "候选商品目录不可用，不能安全重试");
      // Avoid importing a second AI revision over an already approved or
      // published record. Draft/review-pending candidates remain editable and
      // are safe to reuse through the idempotent candidate link.
      const row = getProduct(item.candidateProductId);
      if (!row) throw pipelineStoreError("CANDIDATE_STATUS_UNKNOWN", "候选商品状态无法确认，不能安全重试");
      return ["draft", "review_pending", "needs_changes"].includes(row.status);
    }, nextBudgetTaskId, refundPreviousReservation ? previousTaskId : undefined);
    return retried.pendingBudgetRefund ? settlePendingBudgetRefund(this.store, this.ledger, retried) : retried;
  }

  /** Queue one failed/cancelled item, or a review item explicitly returned
   * for changes, while leaving the rest of the job untouched. The next run
   * uses an item-scoped budget generation so historical usage from sibling
   * items cannot be charged again. */
  retryItem(jobId: string, itemId: string): ImportJob {
    this.assertWritable?.();
    let before = this.store.getJob(jobId);
    if (!before) throw pipelineStoreError("JOB_NOT_FOUND", "Unknown job");
    if (before.pendingBudgetRefund) before = settlePendingBudgetRefund(this.store, this.ledger, before);
    const item = this.store.getItem(itemId);
    if (!item) throw pipelineStoreError("ITEM_NOT_FOUND", "Unknown item");
    if (item.jobId !== jobId) throw pipelineStoreError("ITEM_JOB_MISMATCH", "Item does not belong to this job");
    const activeItemId = itemIdFromBudgetTask(before.budgetTaskId);
    if (["queued", "running"].includes(before.status) && activeItemId) {
      if (activeItemId === itemId) return before;
      throw pipelineStoreError("ITEM_RETRY_CONFLICT", "Another item retry is already queued for this job");
    }

    // A review retry is only safe for a candidate that is still editable. A
    // missing catalog projection is an explicit safety failure rather than a
    // reason to assume that a published row is absent.
    if (item.candidateProductId) {
      if (!this.catalog) throw pipelineStoreError("CATALOG_UNAVAILABLE", "Candidate catalogue is unavailable; retry is blocked");
      const product = getProduct(item.candidateProductId);
      if (!product) throw pipelineStoreError("CANDIDATE_STATUS_UNKNOWN", "Candidate status could not be verified; retry is blocked");
      if (!["draft", "review_pending", "needs_changes"].includes(product.status)) {
        throw pipelineStoreError("ITEM_RETRY_PUBLISHED", "Approved, published or rejected candidates cannot be overwritten by retry");
      }
      if (item.status === "needs_review" && product.status !== "needs_changes" && item.error?.code !== "REVIEW_NEEDS_CHANGES") {
        throw pipelineStoreError("ITEM_RETRY_STATE", "Only needs-changes review items can be retried");
      }
    } else if (item.status === "needs_review" && item.error?.code !== "REVIEW_NEEDS_CHANGES") {
      throw pipelineStoreError("ITEM_RETRY_STATE", "Only needs-changes review items can be retried");
    }

    const previousTaskId = before.budgetTaskId || `job:${jobId}`;
    const previousTask = this.ledger.getTask(previousTaskId);
    let refundPreviousReservation = false;
    if (previousTask?.status === "paused") {
      throw pipelineStoreError("BUDGET_RECONCILIATION_REQUIRED", "Token usage is unresolved; item retry is blocked");
    }
    if (previousTask?.status === "reserved") {
      const attempted = this.store.listItems(jobId).some((candidate) => itemAttemptedForTask(candidate, previousTaskId));
      if (attempted) throw pipelineStoreError("BUDGET_RECONCILIATION_REQUIRED", "The job may have incurred billing with unknown usage; item retry is blocked");
      refundPreviousReservation = true;
    }

    const nextBudgetTaskId = `job:${jobId}:item:${itemId}:retry:${(before.retryCount || 0) + 1}`;
    const retried = this.store.retryItem(jobId, itemId, nextBudgetTaskId, refundPreviousReservation ? previousTaskId : undefined);
    return retried.pendingBudgetRefund ? settlePendingBudgetRefund(this.store, this.ledger, retried) : retried;
  }

  recover(): { jobs: string[]; items: string[] } {
    // Lease recovery mutates durable job/item state just like run(). Keep it
    // behind the same maintenance gate so a restore cannot race requeue writes.
    this.assertWritable?.();
    return this.store.recoverExpiredLeases();
  }

  private resolveProvider(name: string): VisionProvider {
    const factory = this.providers.get(name);
    if (!factory) throw pipelineStoreError("PROVIDER_NOT_FOUND", `Unknown provider ${name}`);
    return typeof factory === "function" ? factory() : factory;
  }

  private async processItem(job: ImportJob, item: ImportItem, provider: VisionProvider, budgetTaskId?: string): Promise<void> {
    let claimed: ImportItem;
    try { claimed = this.store.acquireItemLease(item.id, this.owner, this.leaseTtlMs); } catch (error) {
      if (isErrorWithCode(error) && error.code === "LEASE_BUSY") return;
      throw error;
    }
    const executionTaskId = budgetTaskId || job.budgetTaskId || `job:${job.id}`;
    const heartbeat = setInterval(() => {
      try { this.store.renewJobLease(job.id, this.owner, this.leaseTtlMs); } catch { /* main loop detects a lost lease */ }
    }, Math.max(1_000, Math.floor(this.leaseTtlMs / 3)));
    try {
      // Keep source validation inside the protected region.  Returning before
      // this try/finally used to leak both the heartbeat timer and item lease
      // when an asset record had been removed.
      const source = this.store.getAsset(claimed.sourceAssetId);
      if (!source) throw pipelineError("ASSET_NOT_FOUND", "Source asset is missing", "io");
      const bytes = await readAsset(source);
      const derivative = await deriveImage(bytes, source, this.derivativeRoot, {
        kind: "thumbnail",
        maxWidth: 1_024,
        maxHeight: 1_024,
        quality: 70,
        format: "webp",
        maxPixels: configuredLimit("MAX_IMAGE_PIXELS", 40_000_000),
      });
      this.store.putAsset(derivative.asset);
      const mimeType = asVisionMime(derivative.asset.mimeType);
      const rerunRequested = claimed.aiRaw?.__rerunRequested === true;
      const rerunTaskMarker = typeof claimed.aiRaw?.__rerunTaskId === "string" ? claimed.aiRaw.__rerunTaskId : undefined;
      // The item snapshot stores only the latest response. A retry generation
      // must never carry a sibling/previous-call usage object into its new
      // ledger task; clear it before fencing the provider request. If a worker
      // crashes after this point, the attempted marker makes reconciliation
      // pause conservatively instead of charging stale usage.
      // Persist that a provider request was attempted before awaiting it.  If
      // the process dies or the provider omits usage, reconciliation can stay
      // conservative instead of treating an actually billed item as zero.
      const attempted = this.store.getItem(claimed.id);
      if (attempted) {
        const attemptedRaw = { ...(attempted.aiRaw || {}) };
        delete attemptedRaw.usage;
        this.store.putItem({
          ...attempted,
          aiRaw: { ...attemptedRaw, [PROVIDER_ATTEMPTED_KEY]: true, [PROVIDER_BUDGET_TASK_KEY]: executionTaskId },
          updatedAt: new Date().toISOString(),
        });
      }
      const result = await this.analyzeWithRetry(provider, { bytes: derivative.bytes, mimeType, filename: source.filename });
      const usage = result.usage;
      const providerRaw = { ...(result.raw || {}) };
      // Usage is persisted only after validation below; a provider-supplied
      // raw usage field must not bypass the ledger contract.
      delete providerRaw.usage;
      delete providerRaw[PROVIDER_ATTEMPTED_KEY];
      delete providerRaw[PROVIDER_BUDGET_TASK_KEY];
      delete providerRaw.__rerunRequested;
      delete providerRaw.__rerunTaskId;
      const aiRaw = { ...providerRaw, [PROVIDER_ATTEMPTED_KEY]: true, [PROVIDER_BUDGET_TASK_KEY]: executionTaskId };
      let candidateProductId: string | undefined = claimed.candidateProductId;
      let candidateGroupId: string | undefined = claimed.candidateGroupId;
      if (this.catalog) {
        try {
          const candidate = this.catalog.create({ itemId: claimed.id, jobId: job.id, sourceAssetId: source.id, derivativeAssetId: derivative.asset.id, category: result.category, group: result.group, backLabel: result.backLabel, confidence: result.confidence, rerun: rerunRequested, aiRunId: catalogAiRunId(claimed.id, claimed.attempts, executionTaskId, rerunTaskMarker) });
          candidateProductId = candidate.productId;
          candidateGroupId = candidate.groupId;
        } catch (error) {
          // Catalog writes are a secondary projection. Preserve the AI draft
          // and leave it in manual review if the catalog database is briefly
          // unavailable; the import job itself remains recoverable.
          this.store.event(job.id, "review.required", { itemId: claimed.id, reason: "CATALOG_PROJECTION_FAILED", ...catalogProjectionDiagnostic(error) });
        }
      }
      this.store.transitionItem(claimed.id, this.requireReview ? "needs_review" : "succeeded", { derivativeAssetId: derivative.asset.id, candidateProductId, candidateGroupId, category: result.category, group: result.group, backLabel: result.backLabel, confidence: result.confidence, aiRaw, manualRequired: this.requireReview });
      this.store.event(job.id, this.requireReview ? "review.required" : "item.updated", { itemId: claimed.id, category: result.category, group: result.group });
      // Keep usage in raw item data for reconciliation without expanding the
      // public contract; only validated integer values are retained.
      if (usage) this.store.putItem({ ...this.store.getItem(claimed.id)!, aiRaw: { ...aiRaw, usage }, updatedAt: new Date().toISOString() });
    } catch (error) {
      const classified = classifyError(error, error instanceof AIProviderError ? "provider" : error instanceof BudgetError ? "budget" : "image");
      const manual = classified.class === "provider" || classified.class === "budget";
      this.store.transitionItem(claimed.id, manual ? "needs_review" : "failed", { error: classified, manualRequired: manual });
      if (manual) this.store.event(job.id, "review.required", { itemId: claimed.id, reason: classified.code });
    } finally {
      clearInterval(heartbeat);
      const latest = this.store.getItem(claimed.id);
      if (latest?.lease?.owner === this.owner) {
        delete latest.lease;
        this.store.putItem(latest);
      }
    }
  }

  private async expandZip(source: AssetRecord, limits?: Parameters<typeof extractSafeZip>[2]): Promise<AssetRecord[]> {
    const result = await extractSafeZipFile(source.path, path.dirname(source.path), {
      maxEntries: configuredLimit("MAX_ZIP_ENTRIES", 10_000),
      maxEntryBytes: configuredLimit("MAX_IMAGE_BYTES", 50 * 1024 * 1024),
      maxTotalBytes: configuredLimit("MAX_EXTRACTED_BYTES", 12 * 1024 * 1024 * 1024),
      maxPixels: configuredLimit("MAX_IMAGE_PIXELS", 40_000_000),
      ...limits,
      allowNonImages: false,
    });
    const assets: AssetRecord[] = [];
    for (const entry of result.entries) {
      if (!entry.image) continue;
      const data = await fs.readFile(entry.path);
      const digest = createHash("sha256").update(data).digest("hex");
      const id = randomUUID();
      const asset: AssetRecord = { id, sha256: digest, path: entry.path, filename: entry.name, mimeType: entry.image.mimeType, bytes: data.length, width: entry.image.width, height: entry.image.height, pixels: entry.image.pixels, hasExif: entry.image.hasExif, sourceAssetId: source.id, createdAt: new Date().toISOString() };
      this.store.putAsset(asset);
      assets.push(asset);
    }
    return assets;
  }

  private async analyzeWithRetry(provider: VisionProvider, input: VisionInput): Promise<VisionResult> {
    let attempt = 0;
    while (true) {
      try {
        return await provider.analyze(input);
      } catch (error) {
        attempt += 1;
        // A timeout has unknown billing state and must never be replayed. Only
        // explicit retryable provider failures (429/5xx/network) are retried,
        // with a hard maximum of three attempts.
        if (!(error instanceof AIProviderError) || !error.retryable || error.code === 'PROVIDER_TIMEOUT' || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }
}

function providerFromSnapshot(name: string, encrypted: string): VisionProvider {
  const config = decryptJson<AIProfileConfig>(encrypted);
  return new DeepSeekVisionProvider({
    baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey,
    modelsPath: config.modelsPath, chatPath: config.chatPath,
    inputFormat: config.inputFormat as 'data_url' | 'bytes' | 'base64' | 'image_url' | undefined,
    allowedHosts: config.allowedHosts, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens,
    requireAllowlist: process.env.NODE_ENV === 'production',
  }, name);
}

function pricingFromSnapshot(encrypted: string, provider: string) {
  const config = decryptJson<AIProfileConfig>(encrypted);
  const match = config.priceTable?.find((entry) => entry.model === config.model)
    || config.priceTable?.find((entry) => !entry.model);
  return {
    promptCostPerTokenMinor: match?.promptPriceMinor ?? config.promptPriceMinor ?? 0,
    completionCostPerTokenMinor: match?.completionPriceMinor ?? config.completionPriceMinor ?? 0,
    priceVersion: match?.version || config.priceVersion || `${provider}:unpriced`,
    currency: match?.currency || config.currency || 'CNY',
  };
}

function readAsset(asset: AssetRecord): Promise<Buffer> {
  if (!asset.path || /^(?:https?|file|data):/i.test(asset.path)) throw pipelineStoreError("ASSET_URL", "Asset paths must be local server-generated paths");
  return fs.readFile(asset.path);
}

function classifyError(error: unknown, fallback: PipelineError["class"]): PipelineError {
  if (error instanceof AIProviderError) {
    return {
      code: error.code,
      message: 'Vision provider request failed',
      class: 'provider',
      retryable: error.retryable,
      ...(error.details && typeof error.details.status === 'number' ? { details: { status: error.details.status } } : {}),
    };
  }
  if (isPipelineLikeError(error)) return { code: error.code, message: error.message, class: error.class, retryable: Boolean(error.retryable), ...(error.details ? { details: error.details } : {}) };
  if (error instanceof BudgetError) return { code: error.code, message: error.message, class: "budget", retryable: false, details: error.details };
  if (error instanceof AIProviderError) return { code: error.code, message: error.message, class: "provider", retryable: error.retryable, details: error.details };
  return { code: "PIPELINE_FAILURE", message: error instanceof Error ? error.message : String(error), class: fallback, retryable: false };
}

function settlePendingBudgetRefund(store: PipelineStore, ledger: TokenLedger, job: ImportJob): ImportJob {
  const taskId = job.pendingBudgetRefund;
  if (!taskId) return job;
  ledger.refund(taskId);
  const latest = store.getJob(job.id);
  if (!latest) throw pipelineStoreError("JOB_NOT_FOUND", "Unknown job");
  if (latest.pendingBudgetRefund === taskId) {
    latest.pendingBudgetRefund = undefined;
    store.putJob(latest);
  }
  return store.getJob(job.id) || latest;
}

function pipelineError(code: string, message: string, cls: PipelineError["class"]): PipelineError { return { code, message, class: cls, retryable: false }; }

function reconcileReservation(store: PipelineStore, ledger: TokenLedger, taskId: string, items: ImportItem[], pauseJob: boolean): boolean {
  const task = ledger.getTask(taskId);
  if (!task || task.status === "settled" || task.status === "refunded") return false;
  const settled = ledger.reconcile(taskId, sumKnownUsage(items, taskId));
  if (settled.status === "paused") {
    if (pauseJob) {
      const jobId = jobIdFromBudgetTask(taskId);
      store.transitionJob(jobId, "paused", {
        code: "USAGE_UNKNOWN",
        message: "Provider usage was unavailable; manual budget reconciliation required",
        class: "budget",
        retryable: false,
      });
    }
    return true;
  }
  const jobId = jobIdFromBudgetTask(taskId);
  const job = store.getJob(jobId);
  if (job) {
    job.reservedTokens = settled.reservedTokens;
    job.usedTokens = settled.usedTokens;
    job.estimatedCostMinor = settled.costMinor;
    store.putJob(job);
    store.event(jobId, "budget.updated", { usedTokens: settled.usedTokens, costMinor: settled.costMinor });
  }
  return false;
}

function jobIdFromBudgetTask(taskId: string): string {
  if (!taskId.startsWith("job:")) return taskId;
  return taskId.slice(4).split(":", 1)[0] || taskId;
}

function isWholeJobBudgetTask(taskId: string | undefined): boolean {
  return typeof taskId === "string" && /^job:[^:]+:retry:\d+$/.test(taskId);
}

function itemIdFromBudgetTask(taskId: string | undefined): string | undefined {
  if (typeof taskId !== "string") return undefined;
  const match = /^job:[^:]+:item:([^:]+):retry:\d+$/.exec(taskId);
  return match?.[1];
}

function sumKnownUsage(items: ImportItem[], taskId?: string): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  let prompt = 0, completion = 0, total = 0;
  for (const item of items) {
    if (taskId) {
      const generation = item.aiRaw?.[PROVIDER_BUDGET_TASK_KEY];
      // Legacy first-generation snapshots predate the generation marker. They
      // are attributed to the original job task; retries require an explicit
      // marker so historical usage is never charged a second time.
      if (generation !== taskId && !(generation === undefined && isLegacyBudgetTask(taskId))) continue;
    }
    const usage = item.aiRaw && isRecord(item.aiRaw.usage) ? item.aiRaw.usage : undefined;
    if (usage && isNonNegativeInteger(usage.totalTokens) && isNonNegativeInteger(usage.promptTokens) && isNonNegativeInteger(usage.completionTokens)) {
      if (usage.promptTokens + usage.completionTokens !== usage.totalTokens) return undefined;
      prompt += usage.promptTokens;
      completion += usage.completionTokens;
      total += usage.totalTokens;
      continue;
    }
    // Pure image/I/O/unknown failures are terminal and do not make the job
    // look successful; they are treated as zero usage for reconciliation.  A
    // provider/budget review item, on the other hand, may have been billed
    // without a response and must keep the reservation paused.
    if (item.status === "failed" || item.status === "cancelled") {
      const errorClass = item.error?.class;
      if (errorClass === "provider" || errorClass === "budget") return undefined;
      continue;
    }
    if (item.aiRaw?.[PROVIDER_ATTEMPTED_KEY] === true) return undefined;
    return undefined;
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function isLegacyBudgetTask(taskId: string): boolean {
  // Only the original `job:<uuid>` generation may consume untagged legacy
  // usage. Item/job retry generations must never inherit that usage.
  return /^job:[^:]+$/.test(taskId);
}

function itemAttemptedForTask(item: ImportItem, taskId: string): boolean {
  if (item.aiRaw?.[PROVIDER_ATTEMPTED_KEY] !== true) return false;
  const generation = item.aiRaw?.[PROVIDER_BUDGET_TASK_KEY];
  return generation === taskId || (generation === undefined && isLegacyBudgetTask(taskId));
}

function asVisionMime(value: string): VisionInput["mimeType"] {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  throw pipelineStoreError("IMAGE_MIME", "Derived asset has an unsupported image MIME type");
}
function isErrorWithCode(value: unknown): value is Error & { code: string } {
  return value instanceof Error && "code" in value && typeof value.code === "string";
}
function isPipelineLikeError(value: unknown): value is PipelineError {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" && typeof value.message === "string" && typeof value.class === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function setJobStage(store: PipelineStore, jobId: string, stage: ImportJob["stage"]): void {
  const job = store.getJob(jobId);
  if (!job || job.stage === stage) return;
  job.stage = stage;
  store.putJob(job);
  store.event(jobId, "job.progress", { stage });
}
