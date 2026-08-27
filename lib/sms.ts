import { createHmac, randomInt, randomUUID } from "node:crypto";

export type SmsResult = { delivered: boolean; developmentCode?: string; error?: string };
export const isSmsPreviewMode = () => process.env.NODE_ENV !== "production" || process.env.SMS_PREVIEW_MODE === "true";

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`SMS_CONFIG_${name}`);
  return value;
}

async function sendAliyun(phone: string, code: string): Promise<void> {
  const accessKeyId = required("ALIYUN_SMS_ACCESS_KEY_ID");
  const accessKeySecret = required("ALIYUN_SMS_ACCESS_KEY_SECRET");
  const signName = required("ALIYUN_SMS_SIGN_NAME");
  const templateCode = required("ALIYUN_SMS_TEMPLATE_CODE");
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: phone,
    RegionId: process.env.ALIYUN_SMS_REGION_ID?.trim() || "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join("&");
  const stringToSign = `POST&%2F&${encode(canonical)}`;
  const signature = createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  const body = new URLSearchParams({ ...params, Signature: signature });
  const response = await fetch("https://dysmsapi.aliyuncs.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({})) as { Code?: string; Message?: string };
  if (!response.ok || result.Code !== "OK") throw new Error(`SMS_ALIYUN_${result.Code || response.status}`);
}

export async function sendVerificationSms(phone: string, code?: string): Promise<SmsResult> {
  const actualCode = code ?? String(randomInt(100000, 1000000));
  if (isSmsPreviewMode()) return { delivered: true, developmentCode: actualCode };
  if ((process.env.SMS_PROVIDER?.trim().toLowerCase() || "aliyun") !== "aliyun") {
    return { delivered: false, error: "短信服务配置无效，请联系商户" };
  }
  try {
    await sendAliyun(phone, actualCode);
    return { delivered: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "SMS_UNKNOWN";
    console.error("SMS delivery failed", { reason: reason.replace(/[^A-Z0-9_-]/gi, "_").slice(0, 80) });
    return { delivered: false, error: "短信发送失败，请稍后重试或联系商户" };
  }
}
