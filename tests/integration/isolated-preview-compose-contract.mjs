import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const preview = fs.readFileSync("compose.preview.yaml", "utf8");
const validator = fs.readFileSync("scripts/assert-isolated-preview-compose.mjs", "utf8");
const runner = fs.readFileSync("scripts/validate-isolated-preview.sh", "utf8");
const previewEnv = fs.readFileSync("preview.env.example", "utf8");
for (const suffix of ["order-data", "warehouse-data", "warehouse-media"]) {
  assert.ok(preview.includes("jiawang-sync-preview-${PREVIEW_ID}-" + suffix));
}
assert.doesNotMatch(preview, /jiawang-commerce-new-(?:order-data|warehouse-data|warehouse-media)/);
assert.doesNotMatch(preview, /^s*build:/m);
assert.ok(validator.includes("productionVolumes.has(mount.source)"));
assert.ok(validator.includes("!service.image || service.build"));
assert.match(validator, /@sha256:/);
assert.match(runner, /PREVIEW_ENV_FILE/);
assert.match(runner, /preview must not use a production environment file/);
assert.match(runner, /SMS_PREVIEW_MODE=true/);
assert.match(runner, /must not seed sample products/);
assert.match(previewEnv, /^SMS_PREVIEW_MODE=true$/m);
assert.match(previewEnv, /^SEED_SAMPLE_PRODUCTS=false$/m);
assert.doesNotMatch(previewEnv, /sk-|AKIA|LTAI[0-9A-Z]|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
assert.match(runner, /config --format json/);
assert.doesNotMatch(runner, /down -v|volume prune|docker volume rm/);

const digest = `app@sha256:${"a".repeat(64)}`;
const config = {
  services: Object.fromEntries(["order-web", "order-media-worker", "warehouse-web", "warehouse-worker", "gateway"].map((name) => [name, {
    ...(name === "gateway" ? {} : { image: digest }),
    volumes: [],
  }])),
  volumes: {
    order_data: { name: "jiawang-sync-preview-contract-order-data" },
    warehouse_data: { name: "jiawang-sync-preview-contract-warehouse-data" },
    warehouse_media: { name: "jiawang-sync-preview-contract-warehouse-media" },
  },
};
const validate = (value) => spawnSync(process.execPath, ["scripts/assert-isolated-preview-compose.mjs"], { input: JSON.stringify(value), encoding: "utf8" });
assert.equal(validate(config).status, 0);
assert.notEqual(validate({ ...config, volumes: { ...config.volumes, order_data: { name: "jiawang-commerce-new-order-data" } } }).status, 0);
assert.notEqual(validate({ ...config, services: { ...config.services, "order-web": { image: "app:latest", volumes: [] } } }).status, 0);
console.log("PASS isolated preview Compose contract");
