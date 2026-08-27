#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const warnings = [];
const exists = (file) => fs.existsSync(path.join(root, file));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const requireFile = (file) => { if (!exists(file)) failures.push(`missing file: ${file}`); };
const requireText = (file, text) => { requireFile(file); if (exists(file) && !read(file).includes(text)) failures.push(`${file} missing: ${text}`); };

for (const file of ["Dockerfile", "佳旺仓库系统/Dockerfile", "compose.yaml", "compose.preview.yaml", "compose.images.yaml", "luffy.manifest.json", "proxy/integration.conf"]) requireFile(file);
requireText("Dockerfile", "CMD [\"pnpm\", \"run\", \"start\"]");
requireText("Dockerfile", "ARG NEXT_PUBLIC_INFERENCE_PROXY_URL");
requireText("佳旺仓库系统/Dockerfile", "FROM base AS deps");
requireText("佳旺仓库系统/Dockerfile", "FROM deps AS builder");
requireText("佳旺仓库系统/Dockerfile", "FROM node:20-bookworm-slim AS web");
requireText("佳旺仓库系统/Dockerfile", "FROM deps AS worker");
requireText("佳旺仓库系统/Dockerfile", "CMD [\"node\", \"server.js\"]");
requireText("佳旺仓库系统/Dockerfile", "CMD [\"node\", \"--import\", \"tsx\", \"worker/index.ts\"]");
requireText("compose.yaml", "context: ./佳旺仓库系统");
requireText("compose.yaml", "target: web");
requireText("compose.yaml", "target: worker");
requireText("compose.yaml", "command: [\"pnpm\", \"run\", \"worker:media\"]");
requireText("compose.yaml", "luffy.entrypoint=true");
requireText("compose.yaml", "luffy.port=80");
requireText("compose.yaml", "NEXT_PUBLIC_BASE_PATH: /warehouse");
requireText("compose.yaml", "/warehouse/api/health");
requireText("compose.preview.yaml", "ORDER_CANDIDATE_IMAGE");
requireText("compose.preview.yaml", "WAREHOUSE_WEB_CANDIDATE_IMAGE");
requireText("compose.preview.yaml", "WAREHOUSE_WORKER_CANDIDATE_IMAGE");
requireText("compose.images.yaml", "order-media-worker");

const compose = exists("compose.yaml") ? read("compose.yaml") : "";
const warehouseCompose = exists("佳旺仓库系统/compose.yaml") ? read("佳旺仓库系统/compose.yaml") : "";
if ((compose.match(/services:/g) || []).length !== 1) failures.push("compose.yaml must contain one services section");
if (compose.includes("ports:")) warnings.push("compose.yaml contains ports; verify only gateway exposes host access");
for (const [file, content] of [["compose.yaml", compose], ["佳旺仓库系统/compose.yaml", warehouseCompose]]) {
  if (!content.includes("APP_ORIGIN: ${APP_ORIGIN:?set APP_ORIGIN to the public HTTPS origin}")) failures.push(`${file} must require APP_ORIGIN`);
  if (!content.includes("APP_MASTER_KEY: ${APP_MASTER_KEY:?set APP_MASTER_KEY}")) failures.push(`${file} must require APP_MASTER_KEY`);
  if (!content.includes("REQUIRE_ORIGIN:") || !content.includes("REQUIRE_CSRF:")) failures.push(`${file} must keep origin and CSRF checks enabled`);
}

const log = process.argv.slice(2).join(" ") || "";
const platformHandshake = /x-docker-expose-session-sharedkey|failed to dial gRPC|error reading preface from client/i.test(log);
if (platformHandshake) {
  console.log("PLATFORM_BUILD_SESSION_FAILURE: BuildKit handshake failed before Dockerfile execution; regenerate the platform session key.");
}
if (!process.env.CI) {
  const docker = spawnSync(process.platform === "win32" ? "docker.exe" : "docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (docker.status !== 0) warnings.push("docker unavailable in this environment; Compose config/build/health checks remain unexecuted");
}
if (failures.length) { console.error("PROJECT_BUILD_BASELINE_FAIL"); for (const item of failures) console.error(`- ${item}`); process.exit(1); }
console.log("PROJECT_BUILD_BASELINE_PASS");
console.log("services: order-web, order-media-worker, warehouse-web(web target), warehouse-worker(worker target), gateway");
console.log("contexts: . and ./佳旺仓库系统");
for (const item of warnings) console.log(`WARNING: ${item}`);
