import { isRole, type CreateUserInput, type DeepSeekConfigInput, type LoginInput } from '@/lib/contracts/platform';
import type { BeautyProductInput, ProductVariantInput } from '@/lib/contracts/catalog';

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly fields: Record<string, string>;

  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/**
 * Every JSON endpoint uses a bounded reader. `Request.json()` buffers the
 * complete body before validation, which would let the large upload proxy
 * limit become an application-memory denial of service.
 */
export class RequestBodyLimitError extends Error {
  readonly code = 'BODY_LIMIT';
  readonly status = 413;

  constructor(message = 'Request body is too large') {
    super(message);
    this.name = 'RequestBodyLimitError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} 必须是字符串`, { [field]: 'required' });
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ValidationError(`${field} 长度必须在 ${min}-${max} 个字符之间`, { [field]: 'length' });
  }
  return normalized;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValidationError(`${field} 无效`, { [field]: 'invalid' });
  }
  return value.trim();
}

export function parseLoginInput(value: unknown): LoginInput {
  const body = asRecord(value);
  const username = requiredString(body.username, 'username', 1, 64).toLowerCase();
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) {
    throw new ValidationError('password 长度必须在 8-256 个字符之间', { password: 'length' });
  }
  const password = body.password;
  return { username, password };
}

export function parseCreateUserInput(value: unknown): CreateUserInput {
  const body = asRecord(value);
  const username = requiredString(body.username, 'username', 1, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
    throw new ValidationError('username 只能包含字母、数字、点、下划线和连字符', {
      username: 'format'
    });
  }
  const password = requiredString(body.password, 'password', 8, 256);
  if (!isRole(body.role)) {
    throw new ValidationError('role 必须是 admin、reviewer 或 viewer', { role: 'invalid' });
  }
  return { username, password, role: body.role };
}

export function parseDeepSeekConfigInput(value: unknown): DeepSeekConfigInput {
  const body = asRecord(value);
  const apiKey = optionalString(body.apiKey, 'apiKey', 512);
  const baseUrl = optionalString(body.baseUrl, 'baseUrl', 512);
  const model = optionalString(body.model, 'model', 256);
  const textModel = optionalString(body.textModel, 'textModel', 256);
  const modelsPath = optionalString(body.modelsPath, 'modelsPath', 256);
  const chatPath = optionalString(body.chatPath, 'chatPath', 256);
  const inputFormat = optionalString(body.inputFormat, 'inputFormat', 64);
  const timeoutMs = optionalInteger(body.timeoutMs, 'timeoutMs', 1_000, 10 * 60_000);
  const maxTokens = optionalInteger(body.maxTokens, 'maxTokens', 1, 1_000_000);
  const priceVersion = optionalString(body.priceVersion, 'priceVersion', 128);
  const promptPriceMinor = optionalInteger(body.promptPriceMinor, 'promptPriceMinor', 0, Number.MAX_SAFE_INTEGER);
  const completionPriceMinor = optionalInteger(body.completionPriceMinor, 'completionPriceMinor', 0, Number.MAX_SAFE_INTEGER);
  const currency = optionalString(body.currency, 'currency', 8);
  let priceTable: DeepSeekConfigInput['priceTable'];
  if (body.priceTable !== undefined && body.priceTable !== null) {
    if (!Array.isArray(body.priceTable) || body.priceTable.length > 128) {
      throw new ValidationError('priceTable 必须是最多 128 项的数组', { priceTable: 'invalid' });
    }
    priceTable = body.priceTable.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(`priceTable 第 ${index + 1} 项无效`, { priceTable: 'invalid' });
      }
      const item = value as Record<string, unknown>;
      const version = requiredString(item.version, `priceTable.${index}.version`, 1, 128);
      const itemCurrency = requiredString(item.currency, `priceTable.${index}.currency`, 3, 3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(itemCurrency)) throw new ValidationError('priceTable currency 必须是三位大写货币代码', { priceTable: 'currency' });
      const prompt = requiredInteger(item.promptPriceMinor, `priceTable.${index}.promptPriceMinor`, 0, Number.MAX_SAFE_INTEGER);
      const completion = requiredInteger(item.completionPriceMinor, `priceTable.${index}.completionPriceMinor`, 0, Number.MAX_SAFE_INTEGER);
      let model: string | null = null;
      if (item.model !== undefined && item.model !== null && item.model !== '') model = requiredString(item.model, `priceTable.${index}.model`, 1, 256);
      return { model, version, currency: itemCurrency, promptPriceMinor: prompt, completionPriceMinor: completion };
    });
  }
  const allowedHostsValue = body.allowedHosts;
  let allowedHosts: string[] | undefined;
  if (allowedHostsValue !== undefined && allowedHostsValue !== null) {
    if (!Array.isArray(allowedHostsValue) || allowedHostsValue.length > 32) {
      throw new ValidationError('allowedHosts 必须是最多 32 个主机名的数组', { allowedHosts: 'invalid' });
    }
    allowedHosts = allowedHostsValue.map((value) => {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(value.trim())) {
        throw new ValidationError('allowedHosts 包含无效主机名', { allowedHosts: 'invalid' });
      }
      return value.trim().toLowerCase();
    });
    if (new Set(allowedHosts).size !== allowedHosts.length) throw new ValidationError('allowedHosts 不得重复', { allowedHosts: 'duplicate' });
  }

  if (baseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ValidationError('baseUrl 必须是有效 URL', { baseUrl: 'url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ValidationError('baseUrl 只允许 HTTP(S)', { baseUrl: 'protocol' });
    }
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      throw new ValidationError('生产环境 baseUrl 必须使用 HTTPS', { baseUrl: 'protocol' });
    }
  }
  if (inputFormat !== undefined && !['data_url', 'bytes', 'base64', 'image_url'].includes(inputFormat)) {
    throw new ValidationError('inputFormat 格式无效', { inputFormat: 'format' });
  }
  for (const [value, field] of [[modelsPath, 'modelsPath'], [chatPath, 'chatPath']] as const) {
    if (value !== undefined && (!value.startsWith('/') || value.includes('..') || /[\u0000-\u001f]/.test(value))) {
      throw new ValidationError(`${field} 必须是安全的绝对 API 路径`, { [field]: 'path' });
    }
  }
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency 必须是三位大写货币代码', { currency: 'format' });
  return { apiKey, baseUrl, model, textModel, modelsPath, chatPath, inputFormat, allowedHosts, timeoutMs, maxTokens, priceVersion, promptPriceMinor, completionPriceMinor, currency, priceTable };
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} 必须是 ${min}-${max} 的整数`, { [field]: 'integer' });
  }
  return value;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} 必须是 ${min}-${max} 的整数`, { [field]: 'integer' });
  }
  return value;
}

export async function parseJson(request: Request, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ValidationError('content-length 无效');
    if (length > maxBytes) throw new RequestBodyLimitError();
  }

  let text = '';
  try {
    if (!request.body) {
      text = await request.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new RequestBodyLimitError();
    } else {
      const reader = request.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new RequestBodyLimitError();
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw error;
    throw new ValidationError('请求体必须是有效 UTF-8 JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('请求体必须是有效 JSON');
  }
}

export function parseBeautyProductInput(value: unknown): BeautyProductInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('商品请求体必须是 JSON 对象');
  const body = value as Record<string, unknown>;
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 240) throw new ValidationError('商品名称无效', { name: 'required' });
  if (typeof body.categoryId !== 'string' || !body.categoryId.trim()) throw new ValidationError('分类无效', { categoryId: 'required' });
  if (!Array.isArray(body.variants) || body.variants.length < 1 || body.variants.length > 100) throw new ValidationError('至少需要一个规格', { variants: 'required' });
  const variants: ProductVariantInput[] = body.variants.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`规格 ${index + 1} 无效`, { variants: 'invalid' });
    const variant = value as Record<string, unknown>;
    if (typeof variant.specification !== 'string' || !variant.specification.trim() || variant.specification.length > 240) throw new ValidationError(`规格 ${index + 1} 必须填写规格/包装单位`, { variants: 'specification' });
    const result: ProductVariantInput = { specification: variant.specification.trim() };
    if (variant.id !== undefined && (typeof variant.id !== 'string' || !/^var-[0-9a-f-]{36}$/i.test(variant.id))) throw new ValidationError(`规格 ${index + 1} ID 无效`, { variants: 'id' });
    if (typeof variant.id === 'string') result.id = variant.id;
    for (const key of ['sku', 'barcodeRaw', 'barcodeNormalized', 'barcodeSymbology', 'netContent', 'unit', 'packaging', 'color', 'scent'] as const) {
      const item = variant[key];
      if (item !== undefined && item !== null && typeof item !== 'string') throw new ValidationError(`规格 ${index + 1} 字段无效`, { variants: key });
      if (item !== undefined && item !== null) (result as unknown as Record<string, unknown>)[key] = String(item).slice(0, 240);
    }
    if (variant.price !== undefined && variant.price !== null) {
      if (typeof variant.price !== 'number' || !Number.isFinite(variant.price) || variant.price < 0 || variant.price > 99_999_999) throw new ValidationError(`规格 ${index + 1} 价格无效`, { variants: 'price' });
      result.price = variant.price;
    }
    if (variant.stock !== undefined && variant.stock !== null) {
      if (typeof variant.stock !== 'number' || !Number.isSafeInteger(variant.stock) || variant.stock < 0 || variant.stock > 1_000_000_000) throw new ValidationError(`规格 ${index + 1} 库存无效`, { variants: 'stock' });
      result.stock = variant.stock;
    }
    return result;
  });
  const skuKeys = variants.map((variant) => variant.sku?.trim().toUpperCase()).filter((sku): sku is string => Boolean(sku));
  if (new Set(skuKeys).size !== skuKeys.length) throw new ValidationError('同一商品内 SKU 不能重复', { variants: 'sku_duplicate' });
  const barcodeKeys = variants.map((variant) => (variant.barcodeNormalized || variant.barcodeRaw)?.trim().toUpperCase()).filter((barcode): barcode is string => Boolean(barcode));
  if (new Set(barcodeKeys).size !== barcodeKeys.length) throw new ValidationError('同一商品内商品条码不能重复', { variants: 'barcode_duplicate' });
  const output: BeautyProductInput = { name: body.name.trim(), categoryId: body.categoryId.trim(), variants };
  for (const key of ['brand', 'subcategoryId', 'description', 'ingredients', 'efficacy', 'directions', 'warnings', 'countryOfOrigin', 'manufacturer', 'licenseNumber', 'batchNumber', 'productionDate', 'shelfLife', 'expiryDate', 'notes'] as const) {
    const item = body[key];
    if (item !== undefined && item !== null && typeof item !== 'string') throw new ValidationError(`${key} 必须是字符串`, { [key]: 'invalid' });
    if (typeof item === 'string') (output as unknown as Record<string, unknown>)[key] = item.slice(0, 10_000).trim();
  }
  if (body.assetIds !== undefined) {
    if (!Array.isArray(body.assetIds) || body.assetIds.length > 8) throw new ValidationError('商品图片最多 8 张', { assetIds: 'limit' });
    const assetIds = body.assetIds.map((assetId) => {
      if (typeof assetId !== 'string' || !/^[0-9a-f-]{36}$/i.test(assetId)) throw new ValidationError('商品图片 ID 无效', { assetIds: 'invalid' });
      return assetId;
    });
    if (new Set(assetIds).size !== assetIds.length) throw new ValidationError('商品图片不能重复', { assetIds: 'duplicate' });
    output.assetIds = assetIds;
  }
  return output;
}
