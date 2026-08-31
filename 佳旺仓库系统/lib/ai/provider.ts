import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { ProviderCapabilities, VisionInput, VisionResult, BackLabelFields } from "../contracts/pipeline";
import { parseVisionPayload } from "./extract";

export interface VisionProvider {
  readonly name: string;
  probe(signal?: AbortSignal): Promise<ProviderCapabilities>;
  analyze(input: VisionInput, signal?: AbortSignal): Promise<VisionResult>;
}

export class AIProviderError extends Error {
  readonly code: string;
  readonly class = "provider" as const;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface MockProviderOptions {
  /** Set false to exercise the manual fallback path. */
  available?: boolean;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  result?: VisionResult;
}

/** Deterministic provider for local development and tests. */
export class MockVisionProvider implements VisionProvider {
  readonly name = "mock";
  private readonly options: MockProviderOptions;
  constructor(options: MockProviderOptions = {}) {
    this.options = options;
  }
  async probe(): Promise<ProviderCapabilities> {
    return {
      provider: this.name,
      available: this.options.available !== false,
      vision: this.options.available !== false,
      acceptsDataUrl: true,
      model: this.options.model || "mock-vision",
      ...(this.options.available === false ? { reason: "mock provider disabled" } : {}),
    };
  }
  async analyze(input: VisionInput): Promise<VisionResult> {
    const capability = await this.probe();
    if (!capability.available) throw new AIProviderError("PROVIDER_UNAVAILABLE", "Mock provider is disabled", false);
    if (!SUPPORTED_MIME.has(input.mimeType)) throw new AIProviderError("INPUT_MIME", "Unsupported image MIME type");
    if (!input.bytes.byteLength) throw new AIProviderError("INPUT_EMPTY", "Image bytes are empty");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const categories = ["护肤", "彩妆", "个护", "食品"];
    const groups = ["新品", "主推", "常规", "待定"];
    const index = parseInt(digest.slice(0, 8), 16);
    const result = this.options.result ? clone(this.options.result) : {
      category: categories[index % categories.length],
      group: groups[index % groups.length],
      backLabel: {
        productName: input.filename ? input.filename.replace(/\.[^.]+$/, "") : "待识别商品",
        sku: digest.slice(0, 12).toUpperCase(),
        barcode: digest.slice(12, 25),
      } satisfies BackLabelFields,
      confidence: 0.5 + (index % 50) / 100,
      raw: { mock: true, digest },
      usage: this.options.usage || { promptTokens: 96, completionTokens: 64, totalTokens: 160 },
    } satisfies VisionResult;
    return normalizeUsage(result);
  }
}

export interface DeepSeekProviderOptions {
  baseUrl?: string;
  model?: string;
  textModel?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
  modelsPath?: string;
  chatPath?: string;
  /** Optional explicit host allow-list; prevents accidental SSRF in config. */
  allowedHosts?: string[];
  /** Explicit operator confirmation when the models endpoint omits modalities. */
  visionConfirmed?: boolean;
  /** Provider-specific image transport. `data_url` is the interoperable
   * OpenAI-compatible default; `bytes` sends a base64 byte object and is only
   * enabled after the endpoint probe confirms that mode. */
  inputFormat?: "data_url" | "bytes" | "base64" | "image_url";
  /** Fail closed in production when no host allow-list was configured. */
  requireAllowlist?: boolean;
}

/**
 * OpenAI-compatible DeepSeek adapter. No model, endpoint or key is hardcoded;
 * all three must be supplied through deployment configuration. Image bytes
 * are converted to a data URL, so user supplied URLs are never fetched.
 */
export class DeepSeekVisionProvider implements VisionProvider {
  readonly name: string;
  readonly baseUrl?: string;
  readonly model?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly modelsPath: string;
  private readonly chatPath: string;
  private readonly allowedHosts?: Set<string>;
  private readonly visionConfirmed: boolean;
  private readonly inputFormat: "data_url" | "bytes" | "image_url";
  constructor(options: DeepSeekProviderOptions = {}, name = "deepseek") {
    this.name = name;
    this.baseUrl = normalizeEndpoint(options.baseUrl ?? process.env.DEEPSEEK_BASE_URL);
    this.model = options.model ?? process.env.DEEPSEEK_VISION_MODEL ?? process.env.DEEPSEEK_MODEL;
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 60_000, 10 * 60_000));
    this.maxTokens = Math.max(1, Math.min(options.maxTokens ?? 1_024, 1_000_000));
    this.modelsPath = safeApiPath(options.modelsPath ?? process.env.DEEPSEEK_MODELS_PATH ?? '/models', '/models');
    this.chatPath = safeApiPath(options.chatPath ?? process.env.DEEPSEEK_CHAT_PATH ?? '/chat/completions', '/chat/completions');
    const configuredHosts = options.allowedHosts ?? process.env.DEEPSEEK_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean);
    this.allowedHosts = configuredHosts?.length ? new Set(configuredHosts.map((host) => host.toLowerCase())) : undefined;
    this.visionConfirmed = options.visionConfirmed ?? process.env.DEEPSEEK_VISION_CONFIRMED === "true";
    const configuredFormat = options.inputFormat ?? process.env.DEEPSEEK_INPUT_FORMAT ?? process.env.DEEPSEEK_INPUT_MODE ?? "data_url";
    if (!['data_url', 'bytes', 'base64', 'image_url'].includes(configuredFormat)) throw new AIProviderError('INPUT_FORMAT', 'DeepSeek image input format is unsupported');
    this.inputFormat = configuredFormat === 'base64' ? 'bytes' : configuredFormat as "data_url" | "bytes" | "image_url";
    if (this.baseUrl && this.allowedHosts) {
      const host = new URL(this.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!this.allowedHosts.has(host)) throw new AIProviderError("ENDPOINT_HOST", "Configured DeepSeek endpoint is not allow-listed");
    }
    const requireAllowlist = options.requireAllowlist ?? process.env.NODE_ENV === 'production';
    if (this.baseUrl && requireAllowlist && !this.allowedHosts) throw new AIProviderError('ENDPOINT_HOST', 'A DeepSeek host allow-list is required in production');
  }
  async probe(signal?: AbortSignal): Promise<ProviderCapabilities> {
    if (!this.baseUrl || !this.model || !this.apiKey) return { provider: this.name, available: false, vision: false, acceptsDataUrl: true, model: this.model, reason: "base URL, model and API key are required" };
    try {
      const response = await this.request(this.modelsPath, { method: "GET" }, signal);
      if (!response.ok) return { provider: this.name, available: false, vision: false, acceptsDataUrl: true, model: this.model, reason: `capability probe returned HTTP ${response.status}` };
      let modelAdvertisesVision = false;
      try {
        const body: unknown = await response.json();
        const record = isRecord(body) ? body : {};
        const models = Array.isArray(record.data) ? record.data.filter(isRecord) : [];
        const selected = models.find((entry) => entry.id === this.model);
        if (models.length && !selected) return { provider: this.name, available: false, vision: false, acceptsDataUrl: true, model: this.model, reason: "configured model is not advertised by the endpoint" };
        if (selected) {
          const capabilities = isRecord(selected.capabilities) ? selected.capabilities : {};
          const modalities = Array.isArray(selected.modalities) ? selected.modalities : [];
          modelAdvertisesVision = capabilities.vision === true || modalities.some((value) => value === "image" || value === "vision");
        }
      } catch {
        // Reachability alone is not proof of vision support.
      }
      let imageProbePassed = false;
      if (process.env.DEEPSEEK_PROBE_IMAGE !== 'false') {
        const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
        const imagePart = this.imagePart(tinyPng, 'image/png');
        const imageResponse = await this.request(this.chatPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            max_tokens: 8,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: [
              { type: 'text', text: 'Return JSON only: {"ok":true}' },
              imagePart,
            ] }],
          }),
        }, signal);
        imageProbePassed = imageResponse.ok;
      }
      const vision = process.env.DEEPSEEK_PROBE_IMAGE === 'false'
        ? this.visionConfirmed || modelAdvertisesVision
        : imageProbePassed;
      return { provider: this.name, available: true, vision, acceptsDataUrl: this.inputFormat !== 'bytes', model: this.model, ...(vision ? {} : { reason: "endpoint is reachable but configured vision/input capability is not confirmed" }) };
    } catch (error) {
      // Capability status is shown to ordinary authenticated users and may be
      // persisted for the dashboard. Never carry socket errors, endpoint
      // paths, hostnames or provider response text into that durable/public
      // record; the stable provider code is enough for an administrator to
      // correlate with redacted server logs.
      const code = error instanceof AIProviderError ? error.code : 'PROVIDER_NETWORK';
      return { provider: this.name, available: false, vision: false, acceptsDataUrl: true, model: this.model, reason: `Capability probe failed (${code})` };
    }
  }
  async analyze(input: VisionInput, signal?: AbortSignal): Promise<VisionResult> {
    if (!this.baseUrl || !this.model || !this.apiKey) throw new AIProviderError("PROVIDER_CONFIG", "DeepSeek base URL, model and API key are not configured");
    if (!SUPPORTED_MIME.has(input.mimeType)) throw new AIProviderError("INPUT_MIME", "Only JPEG, PNG and WebP are accepted");
    if (!input.bytes.byteLength) throw new AIProviderError("INPUT_EMPTY", "Image bytes are empty");
    const body = {
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Extract product category, group and back-label fields. Return JSON only with category, group, backLabel and confidence." },
          this.imagePart(Buffer.from(input.bytes), input.mimeType),
        ],
      }],
    };
    let response: Response;
    try {
      response = await this.request(this.chatPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError("PROVIDER_NETWORK", error instanceof Error ? error.message : String(error), true);
    }
    const text = await readResponseText(response, 2 * 1024 * 1024);
    // Keep third-party response bodies out of durable job/error records. They
    // may contain reflected prompts, endpoint diagnostics or secret-like text;
    // the HTTP status and stable provider code are sufficient for retry/UI.
    if (!response.ok) throw new AIProviderError(`HTTP_${response.status}`, `DeepSeek returned HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500, { status: response.status });
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new AIProviderError("PROVIDER_JSON", "DeepSeek response was not JSON", false); }
    const payloadRecord = isRecord(payload) ? payload : {};
    const choices = Array.isArray(payloadRecord.choices) ? payloadRecord.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    if (!choice) throw new AIProviderError("PROVIDER_RESPONSE", "DeepSeek response contains no choices", false);
    const message = isRecord(choice.message) ? choice.message : {};
    const messageContent = message.content;
    const content = typeof messageContent === "string" ? messageContent : Array.isArray(messageContent) ? messageContent.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : "";
    let parsed: VisionResult;
    try { parsed = parseVisionPayload(content); }
    catch (error) { throw new AIProviderError('PROVIDER_SCHEMA', error instanceof Error ? error.message : 'DeepSeek response schema is invalid', false); }
    const usage = usageFromPayload(payloadRecord.usage);
    // Missing usage is intentionally surfaced as undefined. The job runner
    // pauses before charging rather than inventing a token count.
    return { ...parsed, usage, raw: { ...(parsed.raw || {}), provider: this.name, responseId: typeof payloadRecord.id === "string" ? payloadRecord.id : undefined } };
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.baseUrl) throw new AIProviderError("PROVIDER_CONFIG", "DeepSeek endpoint is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const base = new URL(this.baseUrl);
      const endpointUrl = new URL(pathname.replace(/^\//, ""), `${this.baseUrl}/`);
      // API paths are relative to the configured base origin.  Reject any
      // path that turns into an absolute URL (for example `///attacker/...`)
      // before the request can carry the provider Authorization header to a
      // different host.
      if (endpointUrl.origin !== base.origin || endpointUrl.username || endpointUrl.password || endpointUrl.hash) {
        throw new AIProviderError('ENDPOINT_PATH', 'DeepSeek API path escapes the configured endpoint');
      }
      const endpoint = endpointUrl.toString();
      // Hostname allow-lists alone are vulnerable to DNS rebinding. Resolve
      // every request and fail closed if any returned address is loopback,
      // link-local, RFC1918, metadata, or otherwise reserved. Loopback is
      // explicitly permitted for local fixtures only.
      const firstResolution = await assertResolvedEndpoint(endpoint);
      // Re-resolve immediately before opening the connection.  This is not a
      // substitute for network egress controls, but it closes the common
      // check-then-switch DNS-rebinding window instead of trusting a single
      // lookup for the whole request.
      const secondResolution = await assertResolvedEndpoint(endpoint);
      if (!sameAddresses(firstResolution, secondResolution)) {
        throw new AIProviderError('ENDPOINT_DNS_CHANGED', 'DeepSeek endpoint DNS answers changed during validation');
      }
      // Fetch resolves the hostname again after the validation lookup. Use a
      // pinned socket lookup callback so the connection is made to the exact
      // address that passed the SSRF checks. The original Host/SNI is kept for
      // TLS virtual hosting and certificate validation.
      return await requestPinned(endpointUrl, firstResolution[0], { ...init, signal: controller.signal, redirect: "error", headers: { ...(init.headers || {}), authorization: `Bearer ${this.apiKey}` } }, this.timeoutMs);
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (error instanceof Error && (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))) throw new AIProviderError('PROVIDER_TIMEOUT', 'DeepSeek request timed out', false);
      throw new AIProviderError("PROVIDER_NETWORK", error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timer);
    }
  }

  private imagePart(bytes: Uint8Array, mimeType: VisionInput['mimeType']): Record<string, unknown> {
    const base64 = Buffer.from(bytes).toString('base64');
    if (this.inputFormat === 'bytes') return { type: 'image', image: { data: base64, mime_type: mimeType } };
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };
  }
}

/** Make one HTTP(S) request while pinning DNS to a previously validated IP. */
async function requestPinned(endpoint: URL, address: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const transport = endpoint.protocol === 'https:' ? https : http;
  const originalHost = endpoint.hostname.replace(/^\[|\]$/g, '');
  const ipFamily = net.isIP(address) as 4 | 6;
  const headers = new Headers(init.headers);
  headers.set('host', endpoint.host);
  const body = bodyBuffer(init.body);
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.byteLength));
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => { headerRecord[key] = value; });
  const requestOptions: http.RequestOptions & https.RequestOptions = {
    protocol: endpoint.protocol,
    hostname: address,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    method: init.method || 'GET',
    path: `${endpoint.pathname}${endpoint.search}`,
    headers: headerRecord,
    // Node must not perform a second resolver call. The callback is invoked
    // for the already pinned address only.
    lookup: (_hostname, _options, callback) => callback(null, address, ipFamily),
    ...(endpoint.protocol === 'https:' && !net.isIP(originalHost) ? { servername: originalHost } : {}),
  };
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    const request = transport.request(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 4 * 1024 * 1024) {
          response.destroy();
          fail(new AIProviderError('PROVIDER_RESPONSE_TOO_LARGE', 'DeepSeek response exceeds the safety limit'));
          return;
        }
        chunks.push(buffer);
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode || 500, headers: responseHeaders }));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('request timeout'), { name: 'TimeoutError' })));
    request.once('error', fail);
    const abort = () => request.destroy(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
    if (init.signal?.aborted) { abort(); return; }
    init.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    if (body) request.write(body);
    request.end();
  });
}

function bodyBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new AIProviderError('PROVIDER_REQUEST_BODY', 'DeepSeek request body format is unsupported');
}

async function assertResolvedEndpoint(endpoint: string): Promise<string[]> {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowPrivate = process.env.NODE_ENV !== 'production' || process.env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT === 'true';
  if (isMetadataHostname(host)) throw new AIProviderError('ENDPOINT_SSRF', 'DeepSeek endpoint targets a metadata address');
  // Literal IPs need no DNS lookup but still go through the blocklist.
  if (isIpLiteral(host)) {
    assertAddressAllowed(host, allowPrivate);
    return [canonicalAddress(host)];
  }
  let addresses: Array<{ address: string }>;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new AIProviderError('ENDPOINT_DNS', 'DeepSeek endpoint hostname could not be resolved', true); }
  if (!addresses.length) throw new AIProviderError('ENDPOINT_DNS', 'DeepSeek endpoint hostname has no address records', true);
  const normalized = addresses.map((entry) => canonicalAddress(entry.address));
  for (const address of normalized) assertAddressAllowed(address, allowPrivate);
  return [...new Set(normalized)].sort();
}

function isIpLiteral(value: string): boolean {
  return net.isIP(value.replace(/^\[|\]$/g, '').split('%', 1)[0]) !== 0;
}

export function normalizeEndpoint(value?: string): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new AIProviderError("ENDPOINT_URL", "DeepSeek base URL is invalid"); }
  // HTTP is allowed only for loopback development; production endpoints must
  // be TLS-protected. This blocks config-based SSRF to file/data protocols.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host))) throw new AIProviderError("ENDPOINT_PROTOCOL", "DeepSeek endpoint must use HTTPS (HTTP loopback is allowed for tests)");
  if (url.username || url.password) throw new AIProviderError("ENDPOINT_CREDENTIALS", "Credentials in endpoint URL are not allowed");
  if (url.search || url.hash) throw new AIProviderError('ENDPOINT_URL', 'DeepSeek base URL must not contain query or fragment');
  const allowPrivate = process.env.NODE_ENV !== 'production' || process.env.DEEPSEEK_ALLOW_PRIVATE_ENDPOINT === 'true';
  if (isMetadataHostname(host)) throw new AIProviderError('ENDPOINT_SSRF', 'DeepSeek endpoint targets a metadata address');
  if (isIpLiteral(host)) assertAddressAllowed(host, allowPrivate);
  else if (host === 'localhost' && !allowPrivate) throw new AIProviderError('ENDPOINT_SSRF', 'DeepSeek endpoint resolves to a blocked internal address');
  return value.replace(/\/+$/, "");
}

function safeApiPath(value: string, fallback: string): string {
  const normalized = value.trim() || fallback;
  let decoded = normalized;
  try { decoded = decodeURIComponent(normalized); } catch { throw new AIProviderError('ENDPOINT_PATH', 'DeepSeek API path is invalid'); }
  if (!normalized.startsWith('/') || normalized.startsWith('//') || decoded.startsWith('//') || normalized.includes('..') || decoded.includes('..') || normalized.includes('\\') || decoded.includes('\\') || normalized.includes('?') || normalized.includes('#') || decoded.includes('?') || decoded.includes('#') || /[\u0000-\u001f\u007f]/.test(normalized) || /[\u0000-\u001f\u007f]/.test(decoded) || normalized.length > 256) {
    throw new AIProviderError('ENDPOINT_PATH', 'DeepSeek API path is invalid');
  }
  return normalized;
}

function sameAddresses(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMetadataHostname(host: string): boolean {
  return ['metadata.google.internal', 'metadata', 'instance-data.ec2.internal'].includes(host.toLowerCase());
}

function canonicalAddress(host: string): string {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  const mapped = mappedIpv4(normalized);
  return mapped || normalized;
}

function assertAddressAllowed(host: string, allowPrivate: boolean): void {
  const normalized = canonicalAddress(host);
  const classification = classifyAddress(normalized);
  // Metadata, link-local, unspecified, multicast and reserved ranges remain
  // blocked even when a private self-hosted endpoint was explicitly enabled.
  if (classification === 'never' || (classification === 'private' && !allowPrivate)) {
    throw new AIProviderError('ENDPOINT_SSRF', 'DeepSeek endpoint resolves to a blocked internal address');
  }
}

function classifyAddress(host: string): 'public' | 'private' | 'never' {
  const normalized = canonicalAddress(host);
  const version = net.isIP(normalized);
  if (version === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224) return 'never';
    return 'public';
  }
  if (version === 6) {
    const words = ipv6Words(normalized);
    if (!words) return 'never';
    if (words.every((word) => word === 0)) return 'never';
    if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return 'private';
    const first = words[0];
    if ((first & 0xfe00) === 0xfc00) return 'private';
    if ((first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return 'never';
    // Documentation and discard-only prefixes are not valid provider targets.
    if (first === 0x2001 && (words[1] === 0x0db8 || words[1] === 0x0010)) return 'never';
    return 'public';
  }
  return 'never';
}

/** Convert both dotted and hexadecimal IPv4-mapped IPv6 forms to IPv4. */
function mappedIpv4(host: string): string | undefined {
  if (net.isIP(host) !== 6) return undefined;
  const words = ipv6Words(host);
  if (!words || !words.slice(0, 5).every((word) => word === 0) || words[5] !== 0xffff) return undefined;
  return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
}

function ipv6Words(value: string): number[] | undefined {
  let source = value.toLowerCase().split('%', 1)[0];
  const dotted = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (dotted) {
    const bytes = dotted[2].split('.').map(Number);
    if (bytes.some((byte) => byte < 0 || byte > 255)) return undefined;
    source = `${source.slice(0, source.length - dotted[2].length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return undefined;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN);
  return words.length === 8 && words.every(Number.isFinite) ? words : undefined;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new AIProviderError('PROVIDER_RESPONSE_LIMIT', 'DeepSeek response is too large', false);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response limit').catch(() => undefined);
        throw new AIProviderError('PROVIDER_RESPONSE_LIMIT', 'DeepSeek response is too large', false);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function usageFromPayload(value: unknown): VisionResult["usage"] {
  if (!isRecord(value)) return undefined;
  const total = value.total_tokens, prompt = value.prompt_tokens, completion = value.completion_tokens;
  if (![total, prompt, completion].every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)) return undefined;
  if ((prompt as number) + (completion as number) !== (total as number)) return undefined;
  return { promptTokens: prompt as number, completionTokens: completion as number, totalTokens: total as number };
}

function normalizeUsage(result: VisionResult): VisionResult {
  if (!result.usage) return result;
  const usage = result.usage;
  if (![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(Number.isSafeInteger) || usage.promptTokens < 0 || usage.completionTokens < 0 || usage.totalTokens < 0) return { ...result, usage: undefined };
  return result;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
const SUPPORTED_MIME = new Set<VisionInput["mimeType"]>(["image/jpeg", "image/png", "image/webp"]);
