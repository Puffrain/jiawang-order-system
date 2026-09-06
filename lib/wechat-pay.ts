import { createDecipheriv, createHash, createSign, randomBytes, verify as verifySignature } from "node:crypto";
import fs from "node:fs";

type PayResponse = Record<string, unknown>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`WECHAT_PAY_NOT_CONFIGURED:${name}`);
  return value;
}

function readKey(name: string): string {
  const file = required(name);
  try {
    const key = fs.readFileSync(file, "utf8");
    if (!key.includes("BEGIN") || key.length > 32_768) throw new Error("invalid key");
    return key;
  } catch {
    throw new Error(`WECHAT_PAY_NOT_CONFIGURED:${name}`);
  }
}

export function getWechatPayConfig() {
  return {
    appId: required("WECHAT_MINI_APPID"),
    merchantId: required("WECHAT_PAY_MERCHANT_ID"),
    apiV3Key: required("WECHAT_PAY_API_V3_KEY"),
    certSerial: required("WECHAT_PAY_CERT_SERIAL"),
    privateKey: readKey("WECHAT_PAY_PRIVATE_KEY_FILE"),
    publicKey: readKey("WECHAT_PAY_PUBLIC_KEY_FILE"),
    publicKeyId: required("WECHAT_PAY_PUBLIC_KEY_ID"),
    notifyUrl: required("WECHAT_PAY_NOTIFY_URL"),
  };
}

function apiBase() {
  return (process.env.WECHAT_PAY_API_BASE_URL || "https://api.mch.weixin.qq.com").replace(/\/$/, "");
}

function signMessage(privateKey: string, message: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(privateKey, "base64");
}

function requestHeaders(config: ReturnType<typeof getWechatPayConfig>, method: string, path: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const signature = signMessage(config.privateKey, `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.certSerial}",signature="${signature}"`,
  };
}

async function apiRequest<T extends PayResponse = PayResponse>(config: ReturnType<typeof getWechatPayConfig>, method: string, path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const response = await fetch(`${apiBase()}${path}`, { method, headers: requestHeaders(config, method, path, body), body: body || undefined, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
  if (!response.ok) throw new Error(`WECHAT_PAY_API:${response.status}:${result.code || "UNKNOWN"}`);
  return result;
}

export function createOutTradeNo(orderNo: string): string {
  const clean = orderNo.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  return `${clean || "JW"}${Date.now().toString(36).slice(-10)}${randomBytes(2).toString("hex")}`.slice(0, 32);
}

export async function createJsapiPrepay(input: { outTradeNo: string; description: string; totalFen: number; openid: string; orderVersion: number }) {
  const config = getWechatPayConfig();
  if (!Number.isSafeInteger(input.totalFen) || input.totalFen < 1) throw new Error("WECHAT_PAY_AMOUNT_INVALID");
  const result = await apiRequest<{ prepay_id: string }>(config, "POST", "/v3/pay/transactions/jsapi", {
    appid: config.appId, mchid: config.merchantId, description: input.description.slice(0, 127), out_trade_no: input.outTradeNo,
    time_expire: new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"), notify_url: config.notifyUrl,
    attach: JSON.stringify({ orderVersion: input.orderVersion }), amount: { total: input.totalFen, currency: "CNY" }, payer: { openid: input.openid },
  });
  if (!result.prepay_id) throw new Error("WECHAT_PAY_API_INVALID");
  return { ...result, config };
}

export function buildJsapiPayParams(config: ReturnType<typeof getWechatPayConfig>, prepayId: string) {
  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = randomBytes(16).toString("hex");
  const pkg = `prepay_id=${prepayId}`;
  const paySign = signMessage(config.privateKey, `${config.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`);
  return { timeStamp, nonceStr, package: pkg, signType: "RSA", paySign };
}

export async function queryTransaction(outTradeNo: string) {
  const config = getWechatPayConfig();
  return apiRequest(config, "GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.merchantId)}`);
}

export async function createDomesticRefund(input: { outRefundNo: string; transactionId: string; refundFen: number; totalFen: number; reason?: string }) {
  const config = getWechatPayConfig();
  if (!Number.isSafeInteger(input.refundFen) || input.refundFen < 1 || input.refundFen !== input.totalFen) throw new Error("WECHAT_REFUND_FULL_ONLY");
  return apiRequest(config, "POST", "/v3/refund/domestic/refunds", {
    transaction_id: input.transactionId, out_refund_no: input.outRefundNo, reason: input.reason?.slice(0, 80) || "订单退款",
    notify_url: `${config.notifyUrl.replace(/\/notify$/, "")}/refund-notify`, amount: { refund: input.refundFen, total: input.totalFen, currency: "CNY" },
  });
}

export async function queryDomesticRefund(outRefundNo: string) {
  const config = getWechatPayConfig();
  return apiRequest(config, "GET", `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`);
}

export function verifyWechatNotification(input: { timestamp: string; nonce: string; signature: string; serial: string; body: string }, publicKey: string, publicKeyId: string): boolean {
  const timestamp = Number(input.timestamp);
  if (input.serial !== publicKeyId || !/^\d{10}$/.test(input.timestamp) || !Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300 || !input.nonce || input.nonce.length > 128 || input.body.length > 1_000_000) return false;
  try { return verifySignature("RSA-SHA256", Buffer.from(`${input.timestamp}\n${input.nonce}\n${input.body}\n`), publicKey, Buffer.from(input.signature, "base64")); } catch { return false; }
}

export function decryptWechatResource(input: { ciphertext: string; nonce: string; associatedData: string }, apiV3Key: string): string {
  if (apiV3Key.length !== 32 || input.nonce.length !== 12) throw new Error("WECHAT_NOTIFICATION_INVALID");
  const encrypted = Buffer.from(input.ciphertext, "base64");
  if (encrypted.length < 17) throw new Error("WECHAT_NOTIFICATION_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(input.nonce));
  decipher.setAAD(Buffer.from(input.associatedData));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
}

export function hashPayload(payload: string): string { return createHash("sha256").update(payload).digest("hex"); }
