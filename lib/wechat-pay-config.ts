import fs from 'node:fs';

export type WechatPayConfigStatus = {
  ready: boolean;
  missing: string[];
};

export function getWechatPayConfigStatus(env: NodeJS.ProcessEnv = process.env): WechatPayConfigStatus {
  const missing: string[] = [];
  if (!env.WECHAT_MINI_APPID?.trim()) missing.push('WECHAT_MINI_APPID');
  if (!env.WECHAT_PAY_MERCHANT_ID?.trim()) missing.push('WECHAT_PAY_MERCHANT_ID');
  if (!env.WECHAT_PAY_API_V3_KEY || env.WECHAT_PAY_API_V3_KEY.length !== 32) missing.push('WECHAT_PAY_API_V3_KEY');
  if (!env.WECHAT_PAY_CERT_SERIAL?.trim()) missing.push('WECHAT_PAY_CERT_SERIAL');
  if (!env.WECHAT_PAY_PRIVATE_KEY_FILE?.trim() || !fileExists(env.WECHAT_PAY_PRIVATE_KEY_FILE)) missing.push('WECHAT_PAY_PRIVATE_KEY_FILE');
  if (!env.WECHAT_PAY_PUBLIC_KEY_FILE?.trim() || !fileExists(env.WECHAT_PAY_PUBLIC_KEY_FILE)) missing.push('WECHAT_PAY_PUBLIC_KEY_FILE');
  if (!env.WECHAT_PAY_PUBLIC_KEY_ID?.trim()) missing.push('WECHAT_PAY_PUBLIC_KEY_ID');
  if (!env.WECHAT_PAY_NOTIFY_URL?.startsWith('https://')) missing.push('WECHAT_PAY_NOTIFY_URL');
  return { ready: missing.length === 0, missing };
}

function fileExists(filePath: string | undefined) {
  return Boolean(filePath && fs.existsSync(filePath));
}
