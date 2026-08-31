import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { catalogAiRunId, catalogProjectionDiagnostic } from "../../lib/jobs/runner";

test("catalog AI run ids are stable per item and distinct between sibling items", () => {
  assert.equal(catalogAiRunId("item-a", 2, "job:one"), "job:one:attempt:2:item:item-a");
  assert.equal(catalogAiRunId("item-a", 2, "job:one"), catalogAiRunId("item-a", 2, "job:one"));
  assert.notEqual(catalogAiRunId("item-a", 2, "job:one"), catalogAiRunId("item-b", 2, "job:one"));
  assert.equal(catalogAiRunId("item-a", 9, "job:one", "rerun-task"), "rerun-task:ai:item:item-a");
  assert.notEqual(catalogAiRunId("item-a", 9, "job:one", "rerun-task"), catalogAiRunId("item-b", 9, "job:one", "rerun-task"));
});

test("review images prefer product assets and fall back to derivative then source", async () => {
  const route = await fs.readFile(path.join(process.cwd(), "app/api/v1/reviews/route.ts"), "utf8");
  assert.match(route, /productAssetIds\.length > 0 \? productAssetIds : \[derivativeAssetId, sourceAssetId\]/);
  assert.match(route, /new Set\(preferred\.filter/);
  assert.match(route, /reviewImageAssetIds\(assets\.map\(\(asset\) => asset\.assetId\), item\.derivativeAssetId, item\.sourceAssetId\)/);
  assert.match(route, /`\/api\/v1\/media\/\$\{encodeURIComponent\(assetId\)\}`/);
});

test("catalog projection diagnostics retain only a safe code and fixed class", () => {
  assert.deepEqual(catalogProjectionDiagnostic(Object.assign(new Error("contains /private/path and secret"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" })), {
    errorClass: "coded",
    errorCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
  });
  assert.deepEqual(catalogProjectionDiagnostic(Object.assign(new Error("secret"), { code: "unsafe code: secret" })), { errorClass: "coded" });
  assert.deepEqual(catalogProjectionDiagnostic("secret"), { errorClass: "unknown" });
});
