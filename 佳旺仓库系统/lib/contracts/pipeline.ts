/**
 * Contracts shared by the ingest, worker and API layers.
 *
 * The pipeline deliberately uses strings and plain JSON-compatible values at
 * its boundaries.  Buffers are accepted only by the ingest/AI adapters and
 * are never persisted in the job state.
 */

export type UUID = string;

export type UploadStatus = "created" | "uploading" | "completed" | "failed" | "cancelled";

export interface UploadSession {
  id: UUID;
  createdAt: string;
  updatedAt: string;
  /** Directory containing chunks; the path is server generated. */
  chunkDir: string;
  expectedBytes?: number;
  expectedChunks?: number;
  chunkSize: number;
  receivedChunks: number[];
  receivedBytes: number;
  status: UploadStatus;
  originalAssetId?: UUID;
  originalPath?: string;
  sha256?: string;
  filename?: string;
  mimeType?: string;
  error?: PipelineError;
}

export interface AssetRecord {
  id: UUID;
  /** Immutable source bytes are addressed by this digest. */
  sha256: string;
  path: string;
  filename: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  pixels?: number;
  hasExif?: boolean;
  createdAt: string;
  sourceAssetId?: UUID;
  derivativeKind?: "thumbnail" | "preview" | "normalized";
}

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed";

/** Durable business stage shown independently from the transport/status
 * state. A paused/cancelled job retains its last stage for safe resume and
 * operator diagnostics. */
export type JobStage =
  | "queued"
  | "unpacking"
  | "preprocessing"
  | "classifying"
  | "grouping"
  | "extracting"
  | "review_pending"
  | "completed"
  | "failed";

export type ItemStatus =
  | "queued"
  | "running"
  | "paused"
  | "needs_review"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ErrorClass =
  | "validation"
  | "security"
  | "io"
  | "image"
  | "provider"
  | "budget"
  | "cancelled"
  | "unknown";

export interface PipelineError {
  code: string;
  message: string;
  class: ErrorClass;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Lease {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ImportJob {
  id: UUID;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  stage: JobStage;
  sourceAssetId?: UUID;
  uploadId?: UUID;
  itemIds: UUID[];
  totalItems: number;
  completedItems: number;
  failedItems: number;
  provider: string;
  aiProfileId?: string;
  aiProfileRevisionId?: string;
  aiProfileName?: string;
  aiModel?: string;
  aiProfileRevision?: number;
  aiVersionFingerprint?: string;
  /** Encrypted immutable effective configuration. Never expose this field from public APIs. */
  aiConfigSnapshot?: string;
  lease?: Lease;
  cancelRequested: boolean;
  error?: PipelineError;
  /** Integer token reservation (never a floating point number). */
  reservedTokens: number;
  usedTokens?: number;
  estimatedCostMinor?: number;
  /**
   * Token reservation used by the current execution generation.  A retry gets
   * a fresh task id so a settled reservation can never be silently reused.
   * Older snapshots omit this field and continue to use `job:${id}`.
   */
  budgetTaskId?: string;
  /** Number of explicit operator retries performed for this job. */
  retryCount?: number;
  /**
   * Cross-store retry compensation marker. The PipelineStore commit records
   * this before a ledger refund; a crash can therefore be replayed safely and
   * the old reservation is never silently lost.
   */
  pendingBudgetRefund?: string;
}

export interface ImportItem {
  id: UUID;
  jobId: UUID;
  sourceAssetId: UUID;
  derivativeAssetId?: UUID;
  candidateProductId?: string;
  candidateGroupId?: string;
  status: ItemStatus;
  attempts: number;
  lease?: Lease;
  category?: string;
  group?: string;
  backLabel?: BackLabelFields;
  confidence?: number;
  aiRaw?: Record<string, unknown>;
  error?: PipelineError;
  manualRequired: boolean;
  updatedAt: string;
}

export interface BackLabelFields {
  productName?: string;
  brand?: string;
  sku?: string;
  barcode?: string;
  netContent?: string;
  unit?: string;
  packaging?: string;
  color?: string;
  scent?: string;
  ingredients?: string;
  allergens?: string;
  efficacy?: string;
  directions?: string;
  warnings?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  licenseNumber?: string;
  batchNumber?: string;
  productionDate?: string;
  shelfLife?: string;
  expiry?: string;
  price?: string;
  stock?: string;
  [key: string]: string | undefined;
}

export interface GroupRecord {
  id: UUID;
  name: string;
  category?: string;
  itemIds: UUID[];
  createdAt: string;
  updatedAt: string;
}

export interface PipelineEvent {
  id: number;
  jobId: UUID;
  type:
    | "job.created"
    | "job.started"
    | "job.progress"
    | "job.paused"
    | "job.cancelled"
    | "job.completed"
    | "job.failed"
    | "item.updated"
    | "review.required"
    | "budget.updated";
  at: string;
  data: Record<string, unknown>;
}

export interface VisionInput {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  filename?: string;
}

export interface VisionResult {
  category?: string;
  group?: string;
  backLabel?: BackLabelFields;
  confidence?: number;
  raw?: Record<string, unknown>;
  /** Providers may omit usage; callers must pause rather than guess. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ProviderCapabilities {
  provider: string;
  available: boolean;
  vision: boolean;
  acceptsDataUrl: boolean;
  inputFormat?: string;
  model?: string;
  reason?: string;
}

export interface PipelineStoreState {
  version: 1;
  uploads: Record<UUID, UploadSession>;
  assets: Record<UUID, AssetRecord>;
  jobs: Record<UUID, ImportJob>;
  items: Record<UUID, ImportItem>;
  groups: Record<UUID, GroupRecord>;
  events: PipelineEvent[];
  nextEventId: number;
}

export const EMPTY_PIPELINE_STATE: PipelineStoreState = {
  version: 1,
  uploads: {},
  assets: {},
  jobs: {},
  items: {},
  groups: {},
  events: [],
  nextEventId: 1,
};

export function asPipelineError(
  error: unknown,
  fallbackClass: ErrorClass = "unknown",
  fallbackCode = "PIPELINE_ERROR",
): PipelineError {
  if (error && typeof error === "object" && "class" in error && "message" in error) {
    const candidate = error as Partial<PipelineError>;
    return {
      code: candidate.code || fallbackCode,
      message: String(candidate.message),
      class: candidate.class || fallbackClass,
      retryable: Boolean(candidate.retryable),
      ...(candidate.details ? { details: candidate.details } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    class: fallbackClass,
    retryable: false,
  };
}
