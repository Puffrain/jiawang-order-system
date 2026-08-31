import { getPipelineRuntime } from "../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../lib/jobs/http";
import { normalizeBackLabel } from "../../../../lib/ai/extract";
import { assignCandidateItemGroup, clearCandidateItemGroup, listCandidateAssetIds, listCandidateEvidence } from "../../../../lib/catalog/pipeline-candidate";
import { getProduct } from "../../../../lib/catalog-repository";
import { recordAudit } from "../../../../lib/audit";
import { markReviewSyncProcessed } from "../../../../lib/catalog/review-sync";
import { randomUUID } from "node:crypto";

function reviewImageAssetIds(productAssetIds: readonly string[], derivativeAssetId?: string, sourceAssetId?: string): string[] {
  const preferred = productAssetIds.length > 0 ? productAssetIds : [derivativeAssetId, sourceAssetId];
  return [...new Set(preferred.filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0))];
}

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    requirePipelineRole(request, "reviewer");
    const jobId = new URL(request.url).searchParams.get("jobId") || undefined;
    const runtime = getPipelineRuntime();
    const items = runtime.store.listReviewItems(jobId).map((item) => {
      const product = item.candidateProductId ? getProduct(item.candidateProductId) : null;
      const assets = product ? listCandidateAssetIds(product.id) : [];
      const imageAssetIds = reviewImageAssetIds(assets.map((asset) => asset.assetId), item.derivativeAssetId, item.sourceAssetId);
      return {
        ...item,
        productName: product?.name || item.backLabel?.productName,
        categoryId: product?.categoryId,
        fields: item.backLabel || {},
        evidence: product ? listCandidateEvidence(product.id) : [],
        images: imageAssetIds.map((assetId) => ({ id: assetId, previewUrl: `/api/v1/media/${encodeURIComponent(assetId)}`, thumbnailUrl: `/api/v1/media/${encodeURIComponent(assetId)}` })),
        product: product || undefined,
      };
    });
    return ok({ items }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request);
    if (typeof body.itemId !== "string") throw Object.assign(new Error("itemId is required"), { code: "ITEM_ID", class: "validation" });
    if (body.action !== "approve" && body.action !== "reject" && body.action !== "needs_changes") throw Object.assign(new Error("action must be approve, reject or needs_changes"), { code: "REVIEW_ACTION", class: "validation" });
    const runtime = getPipelineRuntime();
    // The file-store fallback has no catalog/revision tables. Never mark an
    // AI item reviewed or approved without the durable catalog projection.
    if (!runtime.catalog) throw Object.assign(new Error("Catalog persistence is unavailable; manual review requires SQLite"), { code: "CATALOG_UNAVAILABLE", class: "io", status: 503 });
    let item = runtime.store.getItem(body.itemId);
    if (!item) throw Object.assign(new Error("Item not found"), { code: "ITEM_NOT_FOUND", class: "validation" });
    if (item.status !== "needs_review") throw Object.assign(new Error("Item is not awaiting review"), { code: "REVIEW_STATE", class: "validation" });
    const patch = {
      category: typeof body.category === "string" ? body.category.trim().slice(0, 120) : item.category,
      group: typeof body.group === "string" ? body.group.trim().slice(0, 120) : item.group,
      // Manual forms need to distinguish an untouched field from an explicit
      // clear. AI parsing keeps empty values out by default; the review API
      // preserves them so a reviewer can remove an incorrect suggestion.
      backLabel: body.backLabel === undefined ? item.backLabel : normalizeBackLabel(body.backLabel, { preserveEmpty: true }),
      manualRequired: body.action !== "approve",
      ...(body.action !== "approve" ? { error: { code: body.action === "needs_changes" ? "REVIEW_NEEDS_CHANGES" : "REVIEW_REJECTED", message: typeof body.reason === "string" ? body.reason.slice(0, 500) : "Reviewer requires a manual decision", class: "validation" as const, retryable: false } } : { error: undefined }),
    };
    let product = null;
    let reviewSyncId: string | undefined;
    if (runtime.catalog) {
      let productId = item.candidateProductId;
      if (!productId) {
        const candidate = runtime.catalog.create({ itemId: item.id, jobId: item.jobId, sourceAssetId: item.sourceAssetId, derivativeAssetId: item.derivativeAssetId, category: patch.category, group: patch.group, backLabel: patch.backLabel, confidence: item.confidence });
        productId = candidate.productId;
        item = runtime.store.putItem({ ...item, candidateProductId: candidate.productId, candidateGroupId: candidate.groupId, updatedAt: new Date().toISOString() });
      }
      const expectedRevision = Number.isSafeInteger(body.revision) ? Number(body.revision) : undefined;
      // Validate the optimistic-concurrency token before creating the human
      // revision. The review decision then targets the revision returned by
      // applyHumanEdits, avoiding a false conflict on every edited item.
      const currentProduct = getProduct(productId);
      if (!currentProduct) throw Object.assign(new Error("Candidate product not found"), { code: "PRODUCT_NOT_FOUND", class: "validation" });
      if (expectedRevision !== undefined && expectedRevision !== currentProduct.revision) throw Object.assign(new Error("审核版本已变化，请刷新后重试"), { code: "REVISION_CONFLICT", class: "validation", status: 409 });
      const reviewedRevision = body.action === 'approve'
        ? runtime.catalog.applyHumanEdits(productId, { category: patch.category, backLabel: patch.backLabel }, expectedRevision).revision
        : currentProduct.revision;
      if (body.action === 'approve' && typeof body.group === 'string') {
        const groupId = patch.group ? assignCandidateItemGroup(item.id, patch.group, patch.category) : (clearCandidateItemGroup(item.id), undefined);
        item = runtime.store.putItem({ ...item, candidateGroupId: groupId, group: patch.group, updatedAt: new Date().toISOString() });
      }
      reviewSyncId = `review-sync-${randomUUID()}`;
      const targetStatus = body.action === "approve" ? "succeeded" : body.action === "needs_changes" ? "needs_review" : "failed";
      // A review request can be retried after the catalog transaction has
      // committed but before the pipeline snapshot was persisted. Treat an
      // already-rejected candidate as an idempotent reject so the retry can
      // finish transitioning the import item instead of returning a generic
      // pipeline error for a terminal product.
      if (body.action === 'reject' && currentProduct.status === 'rejected') {
        product = currentProduct;
      } else {
        product = runtime.catalog.review(
          productId,
          { id: actor.id, role: actor.role as "admin" | "reviewer" },
          body.action,
          typeof body.reason === "string" ? body.reason : undefined,
          reviewedRevision,
          { id: reviewSyncId, itemId: item.id, jobId: item.jobId, targetStatus, patch: patch as Record<string, unknown> },
        );
      }
    }
    const targetStatus = body.action === "approve" ? "succeeded" : body.action === "needs_changes" ? "needs_review" : "failed";
    const updated = runtime.store.transitionItem(item.id, targetStatus, patch);
    // A concurrent terminal decision may cause PipelineStore to return the
    // existing item unchanged.  Never acknowledge the catalog outbox in that
    // case: the durable worker will either reconcile an equivalent status or
    // place the conflict in its administrator repair queue.
    runtime.store.event(item.jobId, "item.updated", { itemId: item.id, status: updated.status, reviewed: true });
    if (reviewSyncId && updated.status === targetStatus) {
      try { markReviewSyncProcessed(reviewSyncId); }
      catch { /* the durable worker will replay the outbox row */ }
    }
    recordAudit({ requestId: id, actorUserId: actor.id, action: `review.${body.action}`, resourceType: 'product', resourceId: product?.id || item.candidateProductId || item.id, metadata: { itemId: item.id, revision: product?.revision, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined } });
    return ok({ item: updated, product }, id);
  } catch (error) { return handlePipelineError(error, id); }
}
