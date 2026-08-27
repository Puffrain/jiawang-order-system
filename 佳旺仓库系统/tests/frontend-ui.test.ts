import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { safeImageUrl as safeReviewImageUrl } from "../lib/media-url";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("管理台页面使用版本化 API 并保留人工审核门槛", () => {
  const imports = source("app/imports/page.tsx");
  const dashboard = source("app/dashboard/page.tsx");
  const detail = source("app/imports/[jobId]/page.tsx");
  const review = source("app/review/page.tsx");
  const catalog = source("app/catalog/page.tsx");
  assert.match(imports, /\/api\/v1\/uploads/);
  assert.match(imports, /\/api\/v1\/import-jobs/);
  assert.match(imports, /EventSource/);
  assert.match(dashboard, /只读账号不显示任务数据/);
  assert.match(detail, /只读账号不能查看导入任务详情/);
  assert.match(detail, /item\.error\?\.code === "REVIEW_REJECTED"/);
  assert.match(detail, /items\.filter\(canRetryItem\)/);
  assert.match(review, /\/api\/v1\/reviews/);
  assert.match(review, /\/api\/v1\/review\/items/);
  assert.match(review, /Number\.isSafeInteger\(selected\.revision\)/);
  assert.match(review, /revision: selected.revision/);
  assert.match(review, /savedCatalogProducts/);
  assert.match(review, /optionalDraftValue/);
  assert.match(review, /revisionOverride/);
  assert.match(review, /审核提交会携带当前修订版/);
  assert.match(review, /action: decision/);
  assert.match(review, /sourceRegion/);
  assert.match(review, /rawValue/);
  assert.match(review, /通过并进入发布/);
  assert.match(review, /处理意见（可选）/);
  assert.match(review, /删除条目/);
  assert.match(review, /decision === "reject" && !window\.confirm/);
  assert.match(review, /if \(decision === "approve"\)/);
  assert.doesNotMatch(review, /if \(!reason\.trim\(\)\)/);
  assert.match(catalog, /\/api\/v1\/exports/);
  assert.match(catalog, /status=all/);
  assert.match(catalog, /review\?product=/);
});

test("只读账号的前端导航不显示写入入口", () => {
  const shell = source("components/app-shell.tsx");
  assert.match(shell, /minimumRole/);
  assert.match(shell, /user\.role === "viewer"/);
  const settings = source("app/settings/page.tsx");
  assert.match(settings, /user\?\.role !== "admin"/);
});

test("审核图片 URL 使用仓库 basePath", () => {
  assert.equal(safeReviewImageUrl("/api/v1/media/a"), "/warehouse/api/v1/media/a");
  assert.equal(safeReviewImageUrl("/warehouse/api/v1/media/a"), "/warehouse/api/v1/media/a");
  assert.equal(safeReviewImageUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  assert.equal(safeReviewImageUrl("http://cdn.example.com/a.jpg"), undefined);
  assert.equal(safeReviewImageUrl("//cdn.example.com/a.jpg"), undefined);
});
