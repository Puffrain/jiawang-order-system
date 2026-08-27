/** Shared platform contracts. Keep business modules dependent on these small types. */

export const ROLES = ['admin', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Ordered from least to most privilege. */
export const ROLE_LEVEL: Record<Role, number> = {
  viewer: 10,
  reviewer: 20,
  admin: 30
};

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  data?: T;
  error?: ApiError;
  requestId: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
}

export interface DeepSeekConfigInput {
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
  /** Optional per-model/version price table. Values are integer minor
   * currency units per token; the configured model entry is snapshotted into
   * each task reservation. */
  priceTable?: DeepSeekPriceTableEntry[];
}

export interface DeepSeekPriceTableEntry {
  model?: string | null;
  version: string;
  currency: string;
  promptPriceMinor: number;
  completionPriceMinor: number;
}

export interface DeepSeekConfigPublic {
  source: 'environment' | 'database' | 'none';
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
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
}

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function hasMinimumRole(actual: Role, required: Role): boolean {
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}
