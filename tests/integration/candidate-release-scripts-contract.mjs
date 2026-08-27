import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const build = fs.readFileSync("scripts/build-node20-candidates.sh", "utf8");
const start = fs.readFileSync("scripts/start-isolated-preview.sh", "utf8");
const prepare = fs.readFileSync("scripts/production-deploy-prepare.sh", "utf8");
const backup = fs.readFileSync("scripts/production-deploy-backup.sh", "utf8");
const cutover = fs.readFileSync("scripts/production-deploy-cutover.sh", "utf8");
const finalize = fs.readFileSync("scripts/production-finalize.sh", "utf8");
const imageTemplate = fs.readFileSync("compose.images.yaml", "utf8");
assert.match(build, /--target web/);
assert.match(build, /--target worker/);
assert.match(build, /process.versions.node/);
assert.match(build, /images.tsv/);
assert.match(build, /sha256:/);
assert.doesNotMatch(build, /docker push|production|jiawang-commerce-new-/);
assert.match(start, /validate-isolated-preview.sh/);
assert.match(start, /--no-build --force-recreate/);
assert.doesNotMatch(start, /down -v|volume prune|docker volume rm|jiawang-commerce-new-/);
for (const script of [prepare, backup, cutover, finalize]) {
  assert.doesNotMatch(script, /202608(17|18)|candidate-202608|deploy-202608|rollback-202608/);
  assert.doesNotMatch(script, /down -v|volume prune|docker volume rm/);
}
assert.match(prepare, /images must use immutable sha256 references/);
assert.match(prepare, /warehouse-volume-init:[\s\S]*image: \$WAREHOUSE_WEB_IMAGE/);
assert.match(backup, /sqlite-online-backup/);
assert.match(backup, /SCRIPT_DIR/);
assert.match(backup, /ORDER_DATA_VOLUME/);
assert.match(backup, /order-uploads\.before\.tar\.gz/);
assert.match(backup, /sha256sum -c SHA256SUMS/);
assert.match(cutover, /PRODUCTION_DEPLOY_APPROVED/);
assert.match(cutover, /sha256sum -c SHA256SUMS/);
assert.match(cutover, /rollback/);
assert.match(cutover, /CANDIDATE_DIR\/proxy\/integration\.conf/);
assert.match(cutover, /BACKUP_DIR\/integration\.conf/);
assert.match(finalize, /production-data-check/);
assert.match(finalize, /SCRIPT_DIR/);
assert.match(finalize, /FINALIZE_PASS/);
assert.doesNotMatch(finalize, /cp -a|install .*production\.env|docker rm|docker network rm/);
assert.ok(imageTemplate.includes("${ORDER_IMAGE:?set ORDER_IMAGE"));
assert.ok(imageTemplate.includes("${WAREHOUSE_WEB_IMAGE:?set WAREHOUSE_WEB_IMAGE"));
assert.ok(imageTemplate.includes("${WAREHOUSE_WORKER_IMAGE:?set WAREHOUSE_WORKER_IMAGE"));
assert.match(imageTemplate, /warehouse-volume-init:[\s\S]*\$\{WAREHOUSE_WEB_IMAGE/);
assert.doesNotMatch(imageTemplate, /:deploy/);

function expectBlocked(script, env, expected) {
  const windowsShell = [
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  ].find((candidate) => fs.existsSync(candidate));
  const shell = process.platform === "win32" ? windowsShell : "sh";
  assert.ok(shell, "Git Bash is required to execute release gate contracts on Windows");
  const result = spawnSync(shell, [path.resolve(script)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${script} unexpectedly succeeded`);
  assert.match(`${result.stdout}${result.stderr}`, expected);
}

expectBlocked("scripts/production-deploy-backup.sh", {}, /RELEASE_ID/);
expectBlocked("scripts/production-deploy-cutover.sh", {
  PRODUCTION_DEPLOY_APPROVED: "false",
  APPROVAL_REFERENCE: "contract-test",
  RELEASE_ID: "contract-test",
  CANDIDATE_DIR: "missing",
  DEPLOY_OVERRIDE: "missing",
  BACKUP_DIR: "missing",
}, /OWNER_APPROVAL_REQUIRED/);
expectBlocked("scripts/production-deploy-prepare.sh", {
  RELEASE_ID: "contract-test",
  CANDIDATE_DIR: "missing",
  ORDER_IMAGE: "jiawang-commerce-order:latest",
  WAREHOUSE_WEB_IMAGE: "jiawang-commerce-warehouse-web:latest",
  WAREHOUSE_WORKER_IMAGE: "jiawang-commerce-warehouse-worker:latest",
}, /images must use immutable sha256 references/);
console.log("PASS candidate release scripts contract");
