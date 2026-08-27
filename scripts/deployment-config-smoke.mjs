#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const files = ["compose.yaml", "佳旺仓库系统/compose.yaml"];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes("APP_ORIGIN: ${APP_ORIGIN:?set APP_ORIGIN to the public HTTPS origin}"), `${file} must fail closed without APP_ORIGIN`);
  assert.ok(content.includes("APP_MASTER_KEY: ${APP_MASTER_KEY:?set APP_MASTER_KEY}"), `${file} must fail closed without APP_MASTER_KEY`);
  assert.ok(!content.includes("APP_MASTER_SECRET"), `${file} must not use the retired APP_MASTER_SECRET alias`);
  assert.match(content, /REQUIRE_ORIGIN:\s*(?:"true"|\$\{REQUIRE_ORIGIN:-true\})/);
  assert.match(content, /REQUIRE_CSRF:\s*(?:"true"|\$\{REQUIRE_CSRF:-true\})/);
  assert.match(content, /condition:\s*service_completed_successfully/, `${file} must initialize named-volume ownership before the app starts`);
  assert.match(content, /chown -R 1000:1000 \/data \/media/, `${file} must make data and media writable by the non-root app user`);
}
const warehouse = fs.readFileSync("佳旺仓库系统/compose.yaml", "utf8");
assert.ok(warehouse.includes("/warehouse/api/health"), "warehouse health checks must include the configured base path");
const root = fs.readFileSync("compose.yaml", "utf8");
assert.ok(root.includes('SESSION_COOKIE_SECURE: "true"'), "production compose must enforce secure session cookies");
for (const variable of ["SESSION_SECRET", "OWNER_PASSWORD", "INTEGRATION_SHARED_SECRET"]) {
  assert.ok(root.includes("${" + variable + ":?set " + variable + "}"), `compose.yaml must require ${variable}`);
}
const preview = fs.readFileSync("compose.preview.yaml", "utf8");
assert.ok(preview.includes('SESSION_COOKIE_SECURE: "false"'), "HTTP isolated preview must explicitly disable secure session cookies");
assert.ok(preview.includes("APP_MASTER_KEY: ${APP_MASTER_KEY:?set APP_MASTER_KEY}"));
assert.ok(!preview.includes("APP_MASTER_SECRET"));
assert.match(preview, /condition:\s*service_completed_successfully/);
assert.match(preview, /chown -R 1000:1000 \/data \/media/);
process.stdout.write("deployment config smoke: required origin and master key; origin and CSRF checks stay enabled\n");
