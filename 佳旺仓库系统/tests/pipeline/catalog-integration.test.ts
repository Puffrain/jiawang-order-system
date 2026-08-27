import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

test("pipeline candidate is idempotent and approval publishes product/variant", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-catalog-"));
  const database = path.join(temp, "catalog.db");
  process.env.DATABASE_PATH = database;
  const { getDb, closeDb } = await import("../../lib/db");
  try {
    let db;
    try { db = getDb(); } catch {
      t.skip("better-sqlite3 native binding is unavailable for this Node runtime");
      return;
    }
    const { CatalogCandidateService } = await import("../../lib/catalog/pipeline-candidate");
    const service = new CatalogCandidateService(db);
    const first = service.create({ itemId: "item-one", jobId: "job-one", sourceAssetId: "asset-original", derivativeAssetId: "asset-preview", category: "pending", group: "one", backLabel: { productName: "测试商品", sku: "SKU-1", netContent: "100ml" }, confidence: 0.9 });
    assert.equal(first.product?.entrySource, "ai");
    assert.deepEqual(first.product?.assetIds, ["asset-original", "asset-preview"]);
    const second = service.create({ itemId: "item-one", jobId: "job-one", sourceAssetId: "asset-original" });
    assert.equal(second.productId, first.productId);
    assert.equal(second.idempotent, true);
    const edited = service.applyHumanEdits(first.productId, { backLabel: { productName: "人工确认商品" } }, 1);
    assert.deepEqual(edited.assetIds, ["asset-original", "asset-preview"]);
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES ('reviewer-one','reviewer-one','test','reviewer',1,datetime('now'),datetime('now'))").run();
    const published = service.review(first.productId, { id: "reviewer-one", role: "reviewer" }, "approve", undefined, edited.revision);
    assert.equal(published.status, "published");
    assert.equal(published.variants.length, 1);
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("candidate rerun appends AI evidence while preserving human and published values", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-catalog-rerun-"));
  const database = path.join(temp, "catalog.db");
  process.env.DATABASE_PATH = database;
  const { getDb, closeDb } = await import("../../lib/db");
  try {
    let db;
    try { db = getDb(); } catch {
      t.skip("better-sqlite3 native binding is unavailable for this Node runtime");
      return;
    }
    const { CatalogCandidateService, listCandidateEvidence } = await import("../../lib/catalog/pipeline-candidate");
    const service = new CatalogCandidateService(db);
    const first = service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original", category: "pending", backLabel: { productName: "AI one", sku: "SKU-1", netContent: "100ml" }, confidence: 0.8, aiRunId: "run-one" });
    const second = service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original", category: "pending", backLabel: { productName: "AI two", sku: "SKU-2", netContent: "200ml" }, confidence: 0.9, rerun: true, aiRunId: "run-two" });
    assert.equal(second.productId, first.productId);
    assert.equal(second.idempotent, false);
    assert.equal(second.product?.revision, 2);
    assert.equal(second.product?.name, "AI two");
    assert.ok(listCandidateEvidence(first.productId).some((entry) => entry.aiRunId === "run-two" && entry.rawValue === "AI two"));

    const edited = service.applyHumanEdits(first.productId, { backLabel: { productName: "Human name" } }, 2);
    db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES ('reviewer-rerun','reviewer-rerun','test','reviewer',1,datetime('now'),datetime('now'))").run();
    const needsChanges = service.review(first.productId, { id: "reviewer-rerun", role: "reviewer" }, "needs_changes", "rerun", edited.revision);
    assert.equal(needsChanges.status, "needs_changes");
    const third = service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original", category: "pending", backLabel: { productName: "AI must not replace human", sku: "SKU-3", netContent: "300ml" }, confidence: 0.95, rerun: true, aiRunId: "run-three" });
    assert.equal(third.product?.status, "review_pending");
    assert.equal(third.product?.name, "Human name");
    assert.equal(third.product?.variants[0]?.sku, "SKU-3");
    assert.ok(listCandidateEvidence(first.productId).some((entry) => entry.aiRunId === "run-three" && entry.rawValue === "AI must not replace human"));
    const replay = service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original", rerun: true, aiRunId: "run-three" });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.product?.revision, third.product?.revision);

    const published = service.review(first.productId, { id: "reviewer-rerun", role: "reviewer" }, "approve", undefined, third.product?.revision);
    assert.equal(published.status, "published");
    assert.throws(() => service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original", backLabel: { productName: "unsafe" }, rerun: true, aiRunId: "run-four" }), /cannot be overwritten|retry is blocked/i);
    assert.equal(service.create({ itemId: "item-rerun", jobId: "job-rerun", sourceAssetId: "asset-original" }).product?.name, "Human name");
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("empty AI rerun keeps a durable generation marker and is idempotent", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jw-catalog-empty-rerun-"));
  const database = path.join(temp, "catalog.db");
  process.env.DATABASE_PATH = database;
  const { getDb, closeDb } = await import("../../lib/db");
  try {
    let db;
    try { db = getDb(); } catch {
      t.skip("better-sqlite3 native binding is unavailable for this Node runtime");
      return;
    }
    const { CatalogCandidateService } = await import("../../lib/catalog/pipeline-candidate");
    const service = new CatalogCandidateService(db);
    const first = service.create({ itemId: "item-empty-rerun", jobId: "job-empty-rerun", sourceAssetId: "asset-empty", aiRunId: "empty-one" });
    const replay = service.create({ itemId: "item-empty-rerun", jobId: "job-empty-rerun", sourceAssetId: "asset-empty", rerun: true, aiRunId: "empty-one" });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.revision, first.revision);
  } finally {
    closeDb();
    delete process.env.DATABASE_PATH;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
