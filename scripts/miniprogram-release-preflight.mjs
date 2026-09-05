#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "miniprogram");
const sourceProjectConfig = path.join(sourceDir, "project.config.json");
const prepare = process.argv.includes("--prepare");
const placeholders = new Set([
  "replace-with-wechat-mini-appid",
  "replace-with-wechat-mini-secret",
  "your-appid",
  "your-secret",
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, name + " is required");
  assert.ok(!placeholders.has(value.toLowerCase()), name + " must not use a template placeholder");
  return value;
}

const appId = requiredEnvironment("WECHAT_MINI_APPID");
assert.match(appId, /^wx[a-z0-9]{16}$/i, "WECHAT_MINI_APPID must be a WeChat mini-program AppID");

const configSource = fs.readFileSync(path.join(sourceDir, "utils", "config.js"), "utf8");
const apiBaseUrl = configSource.match(/apiBaseUrl:\s*['"]([^'"]+)['"]/u)?.[1];
assert.ok(apiBaseUrl, "miniprogram API address is missing");
const apiUrl = new URL(apiBaseUrl);
assert.equal(apiUrl.protocol, "https:", "miniprogram API address must use HTTPS");
assert.ok(apiUrl.hostname, "miniprogram API address must include a hostname");

const sourceConfig = JSON.parse(fs.readFileSync(sourceProjectConfig, "utf8"));
assert.equal(sourceConfig.appid, "", "source project.config.json must not contain an AppID");
const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
for (const name of ["WECHAT_MINI_APPID", "WECHAT_MINI_SECRET"]) {
  const requiredEntry = name + ": " + "$" + "{" + name + ":?set " + name + "}";
  assert.ok(compose.includes(requiredEntry), "production compose must require " + name);
}

if (!prepare) {
  requiredEnvironment("WECHAT_MINI_SECRET");
  process.stdout.write("mini-program preflight passed for " + apiUrl.origin + "; source AppID remains empty\n");
  process.exit(0);
}

const uploadDir = path.join(root, ".task-runs", "miniprogram-upload");
assert.ok(!fs.existsSync(uploadDir), "upload directory already exists: " + uploadDir + ". Remove it after the previous upload attempt before preparing another one.");
fs.mkdirSync(path.dirname(uploadDir), { recursive: true });
fs.cpSync(sourceDir, uploadDir, { recursive: true });
const uploadProjectConfig = path.join(uploadDir, "project.config.json");
const uploadConfig = JSON.parse(fs.readFileSync(uploadProjectConfig, "utf8"));
uploadConfig.appid = appId;
fs.writeFileSync(uploadProjectConfig, JSON.stringify(uploadConfig, null, 2) + "\n", "utf8");
assert.equal(JSON.parse(fs.readFileSync(uploadProjectConfig, "utf8")).appid, appId);
assert.equal(JSON.parse(fs.readFileSync(sourceProjectConfig, "utf8")).appid, "");
process.stdout.write("mini-program upload copy prepared at " + uploadDir + "; only AppID was written to the copy\n");
