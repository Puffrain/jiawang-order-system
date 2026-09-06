import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { getWechatPayConfigStatus } from "../../lib/wechat-pay-config.ts";
import { decryptWechatResource, verifyWechatNotification } from "../../lib/wechat-pay.ts";
const original = { ...process.env };
try {
  for (const key of ["WECHAT_MINI_APPID","WECHAT_PAY_MERCHANT_ID","WECHAT_PAY_API_V3_KEY","WECHAT_PAY_CERT_SERIAL","WECHAT_PAY_PRIVATE_KEY_FILE","WECHAT_PAY_PUBLIC_KEY_FILE","WECHAT_PAY_PUBLIC_KEY_ID","WECHAT_PAY_NOTIFY_URL"]) delete process.env[key];
  assert.equal(getWechatPayConfigStatus().ready, false);
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const timestamp = Math.floor(Date.now() / 1000).toString(); const nonce = "nonce-123456"; const body = JSON.stringify({ id: "notification-1" });
  const message = timestamp + "\n" + nonce + "\n" + body + "\n";
  const signature = sign("RSA-SHA256", Buffer.from(message), kp.privateKey).toString("base64");
  const pem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyWechatNotification({ timestamp, nonce, signature, serial: "serial-1", body }, pem, "serial-1"), true);
  assert.equal(verifyWechatNotification({ timestamp: String(Number(timestamp) - 601), nonce, signature, serial: "serial-1", body }, pem, "serial-1"), false);
  const key = "0123456789abcdef0123456789abcdef"; const nonce12 = "0123456789ab"; const aad = "wechat"; const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce12)); cipher.setAAD(Buffer.from(aad)); const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ok: true })), cipher.final(), cipher.getAuthTag()]).toString("base64");
  assert.deepEqual(JSON.parse(decryptWechatResource({ ciphertext: encrypted, nonce: nonce12, associatedData: aad }, key)), { ok: true });
  console.log("wechat-pay-contract: PASS");
} finally { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); }
