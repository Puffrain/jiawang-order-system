/**
 * Small browser-side client for the versioned JSON API.
 *
 * The UI intentionally treats every non-2xx response as an error.  This keeps
 * loading/empty/error states honest while the service is being deployed on an
 * internal network and avoids presenting optimistic "success" messages.
 */

export interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
  requestId?: string;
  [key: string]: unknown;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, requestId?: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return Boolean(value && typeof value === "object" && ("data" in value || "error" in value));
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  const text = await response.text();
  return text || undefined;
}

function errorFromBody(body: unknown, status: number): ApiClientError {
  if (isEnvelope(body) && body.error) {
    return new ApiClientError(
      String(body.error.message || "请求失败，请稍后重试"),
      status,
      body.error.code,
      typeof body.requestId === "string" ? body.requestId : undefined,
      body.error.details,
    );
  }
  if (body && typeof body === "object" && "message" in body) {
    return new ApiClientError(String((body as { message?: unknown }).message), status);
  }
  return new ApiClientError(
    typeof body === "string" && body.trim() ? body : `请求失败（${status}）`,
    status,
  );
}

/** Return a typed payload and unwrap the platform's { data, requestId } envelope. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !(init.body instanceof Blob) && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && typeof document !== "undefined" && !headers.has("x-csrf-token")) {
    const token = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("jw_csrf="))?.slice("jw_csrf=".length);
    if (token) {
      try { headers.set("x-csrf-token", decodeURIComponent(token)); }
      catch { headers.set("x-csrf-token", token); }
    }
  }
  try {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";
    const target = path.startsWith("/api/") ? `${basePath}${path}` : path;
    response = await fetch(target, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (error) {
    throw new ApiClientError(error instanceof Error ? error.message : "网络连接失败", 0);
  }

  const body = await readBody(response);
  if (!response.ok) throw errorFromBody(body, response.status);
  if (isEnvelope(body)) return (body.data === undefined ? body : body.data) as T;
  return body as T;
}

export async function apiJson<T>(path: string, method: string, payload?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

export function apiErrorMessage(error: unknown, fallback = "服务暂时不可用，请检查内网连接") {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "登录已过期，请重新登录";
    if (error.status === 403) return "当前账号没有执行此操作的权限";
    const message = error.message || fallback;
    return error.requestId ? `${message}（请求编号：${error.requestId}）` : message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function asList<T>(value: unknown, keys: string[] = ["items", "records", "results"]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}
