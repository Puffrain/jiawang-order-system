"use client";

/* Preview URLs are signed by the internal media endpoint, so the host is
 * intentionally not fixed in next/image remotePatterns. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BeautyProductInput, ProductRecord } from "../../lib/contracts/catalog";
import type { BackLabelFields, GroupRecord } from "../../lib/contracts/pipeline";
import { AppShell, useSession } from "../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson, asList } from "../../components/api-client";
import { AlertIcon, RefreshIcon, ReviewIcon } from "../../components/icon";
import { EmptyState, ErrorState, LoadingBlock, Notice, ProgressBar, SectionHeader, StatusBadge } from "../../components/ui";
import { safeImageUrl } from "../../lib/media-url";

type ReviewSource = "pipeline" | "catalog";

interface ReviewImage {
  id?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  alt?: string;
}

interface ReviewEvidence {
  fieldKey: string;
  rawValue?: string;
  normalizedValue?: string;
  confidence?: number;
  source?: string;
  state?: string;
  sourceRegion?: { x: number; y: number; width: number; height: number } | null;
  sourceAssetIds?: string[];
}

interface ReviewCandidate {
  id: string;
  source: ReviewSource;
  productId?: string;
  candidateProductId?: string;
  revision?: number;
  status?: string;
  productName?: string;
  name?: string;
  category?: string;
  categoryId?: string;
  group?: string;
  groupId?: string;
  confidence?: number;
  manualRequired?: boolean;
  backLabel?: BackLabelFields;
  fields?: Record<string, unknown>;
  evidence?: ReviewEvidence[];
  images?: ReviewImage[];
  previewUrl?: string;
  thumbnailUrl?: string;
  updatedAt?: string;
  error?: { message?: string };
  product?: ProductRecord;
}

const fieldLabels: Array<{ key: string; label: string }> = [
  { key: "productName", label: "商品名称" },
  { key: "category", label: "分类" },
  { key: "group", label: "候选分组" },
  { key: "sku", label: "SKU" },
  { key: "barcode", label: "条码" },
  { key: "netContent", label: "净含量 / 规格" },
  { key: "ingredients", label: "成分" },
  { key: "allergens", label: "过敏原" },
  { key: "manufacturer", label: "生产商" },
  { key: "countryOfOrigin", label: "原产地" },
  { key: "expiry", label: "保质期 / 有效期" },
];

function valueFor(item: ReviewCandidate, key: string) {
  if (key === "productName") return item.productName ?? item.name ?? "";
  if (key === "category") return item.category ?? item.categoryId ?? "";
  if (key === "group") return item.group ?? item.groupId ?? "";
  if (key === "countryOfOrigin" && item.product?.countryOfOrigin) return item.product.countryOfOrigin;
  if (key === "expiry" && item.product?.expiryDate) return item.product.expiryDate;
  const direct = item[key as keyof ReviewCandidate];
  if (typeof direct === "string") return direct;
  const fromFields = item.fields?.[key];
  if (typeof fromFields === "string" || typeof fromFields === "number") return String(fromFields);
  const fromBackLabel = item.backLabel?.[key];
  return fromBackLabel ?? "";
}

function optionalText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : undefined;
}

function optionalDraftValue(draft: Record<string, string>, key: string, fallback?: string | null) {
  if (!Object.prototype.hasOwnProperty.call(draft, key)) return fallback;
  return optionalText(draft[key]) ?? null;
}

function productFromPayload(payload: unknown): ProductRecord | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = "product" in payload ? (payload as { product?: unknown }).product : payload;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ProductRecord>;
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.categoryId !== "string" || !Array.isArray(record.variants)) return undefined;
  return value as ProductRecord;
}

function productIdFor(item: ReviewCandidate) {
  return item.productId || item.candidateProductId || item.product?.id;
}

function catalogCandidate(product: ProductRecord, sourceData: Partial<ReviewCandidate> = {}): ReviewCandidate {
  const variant = product.variants[0];
  const assetImages = (product.assetIds || []).map((assetId) => ({
    id: assetId,
    previewUrl: `/api/v1/media/${encodeURIComponent(assetId)}`,
    thumbnailUrl: `/api/v1/media/${encodeURIComponent(assetId)}`,
  }));
  const images = assetImages.length > 0
    ? assetImages
    : product.previewUrl || product.thumbnailUrl
      ? [{ id: product.id, previewUrl: product.previewUrl || product.thumbnailUrl || undefined, thumbnailUrl: product.thumbnailUrl || product.previewUrl || undefined }]
      : [];
  const backLabel: BackLabelFields = {
    productName: optionalText(product.name),
    sku: optionalText(variant?.sku),
    barcode: optionalText(variant?.barcodeRaw || variant?.barcodeNormalized),
    netContent: optionalText(variant?.netContent || variant?.specification),
    ingredients: optionalText(product.ingredients),
    allergens: optionalText(product.warnings),
    manufacturer: optionalText(product.manufacturer),
    countryOfOrigin: optionalText(product.countryOfOrigin),
    expiry: optionalText(product.expiryDate),
  };
  return {
    source: "catalog",
    revision: product.revision,
    status: product.status,
    productName: product.name,
    name: product.name,
    category: product.categoryId,
    categoryId: product.categoryId,
    backLabel: sourceData.backLabel || backLabel,
    fields: sourceData.fields || { ...backLabel },
    evidence: sourceData.evidence,
    confidence: sourceData.confidence,
    images: sourceData.images || images,
    previewUrl: product.previewUrl || undefined,
    thumbnailUrl: product.thumbnailUrl || product.previewUrl || undefined,
    updatedAt: product.updatedAt,
    ...sourceData,
    // The API cannot override these identity fields with arbitrary payload
    // data; keep the catalog record as the canonical source.
    id: product.id,
    productId: product.id,
    product,
  };
}

function productInputFromDraft(product: ProductRecord, draft: Record<string, string>): BeautyProductInput {
  const currentVariant = product.variants[0] || { specification: "待补充" };
  const firstVariant = {
    ...currentVariant,
    sku: optionalDraftValue(draft, "sku", currentVariant.sku),
    barcodeRaw: optionalDraftValue(draft, "barcode", currentVariant.barcodeRaw || currentVariant.barcodeNormalized),
    barcodeNormalized: undefined,
    barcodeSymbology: undefined,
    barcodeValid: undefined,
    netContent: optionalDraftValue(draft, "netContent", currentVariant.netContent),
    specification: optionalText(draft.netContent) || currentVariant.specification || "待补充",
  };
  const variants = product.variants.length > 0
    ? product.variants.map((variant, index) => index === 0 ? firstVariant : variant)
    : [firstVariant];
  return {
    name: optionalText(draft.productName) || product.name,
    brand: product.brand,
    categoryId: optionalText(draft.category) || product.categoryId,
    subcategoryId: product.subcategoryId,
    description: product.description,
    ingredients: optionalDraftValue(draft, "ingredients", product.ingredients),
    efficacy: product.efficacy,
    directions: product.directions,
    warnings: optionalDraftValue(draft, "allergens", product.warnings),
    countryOfOrigin: optionalDraftValue(draft, "countryOfOrigin", product.countryOfOrigin),
    manufacturer: optionalDraftValue(draft, "manufacturer", product.manufacturer),
    licenseNumber: product.licenseNumber,
    batchNumber: product.batchNumber,
    productionDate: product.productionDate,
    shelfLife: product.shelfLife,
    expiryDate: optionalDraftValue(draft, "expiry", product.expiryDate),
    notes: product.notes,
    variants,
    sourceGroupId: product.sourceGroupId,
  };
}

function formatConfidence(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "未知";
}

function formatRegion(region?: ReviewEvidence["sourceRegion"]) {
  if (!region) return "";
  return `区域 ${Math.round(region.x)},${Math.round(region.y)} · ${Math.round(region.width)}×${Math.round(region.height)}`;
}

function ReviewContent() {
  const { user } = useSession();
  const [items, setItems] = useState<ReviewCandidate[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject" | "needs_changes" | null>(null);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Catalog editing and the review decision are separate API calls. Keep the
  // server-returned revision so a failed decision can be retried without the
  // stale If-Match value from the queue snapshot.
  const [savedCatalogProducts, setSavedCatalogProducts] = useState<Record<string, ProductRecord>>({});
  const [requestedProductId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("product")?.trim() || "";
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGroupError(null);
      const groupPromise = apiFetch<unknown>("/api/v1/groups", { cache: "no-store" }).catch((cause) => {
        setGroupError(apiErrorMessage(cause, "分组接口暂不可用"));
        return { groups: [] };
      });
      let pipelineItems: ReviewCandidate[] = [];
      let pipelineFailure: unknown;
      try {
        pipelineItems = asList<ReviewCandidate>(await apiFetch<unknown>("/api/v1/reviews", { cache: "no-store" }), ["items", "records", "results"]).map((item) => ({ ...item, source: "pipeline", revision: item.revision ?? item.product?.revision }));
      } catch (cause) {
        pipelineFailure = cause;
        if (!requestedProductId) throw cause;
      }

      let catalogItems: ReviewCandidate[] = [];
      try {
        const catalogPayload = await apiFetch<unknown>('/api/v1/review/items?limit=500', { cache: 'no-store' });
        catalogItems = asList<ReviewCandidate & ProductRecord>(catalogPayload, ['items', 'products', 'records']).map((entry) => {
          const product = entry.product && typeof entry.product === 'object' ? entry.product : entry;
          return catalogCandidate(product as ProductRecord, entry);
        });
      } catch (cause) {
        // A catalog projection may be unavailable during an import; preserve
        // the pipeline queue and surface an error only when it is the sole
        // source requested by the user.
        if (!pipelineItems.length && requestedProductId) throw cause;
      }

      const seenProducts = new Set(pipelineItems.map((item) => productIdFor(item) || item.id));
      let next = [...pipelineItems, ...catalogItems.filter((item) => !seenProducts.has(productIdFor(item) || item.id))];
      if (requestedProductId) {
        const requestedMatch = next.find((item) => item.id === requestedProductId || productIdFor(item) === requestedProductId);
        if (requestedMatch) {
          next = [requestedMatch];
        } else {
          try {
            const catalogPayload = await apiFetch<unknown>(`/api/v1/review/items?limit=500&productId=${encodeURIComponent(requestedProductId)}`, { cache: "no-store" });
            const candidate = asList<ReviewCandidate & ProductRecord>(catalogPayload, ["items", "products", "records"]).find((entry) => (entry.product?.id || entry.id) === requestedProductId);
            const product = candidate?.product && typeof candidate.product === 'object' ? candidate.product : candidate;
            if (!product || typeof product !== 'object') throw new Error("该商品不在待审核队列中，可能已经发布或被移除");
            next = [catalogCandidate(product as ProductRecord, candidate)];
          } catch (cause) {
            throw pipelineFailure || cause;
          }
        }
      }

      const groupPayload = await groupPromise;
      setGroups(asList<GroupRecord>(groupPayload, ["groups", "items", "records"]));
      setItems(next);
      setSelectedId((current) => requestedProductId && next[0] ? next[0].id : current && next.some((item) => item.id === current) ? current : next[0]?.id || null);
    } catch (cause) {
      setError(apiErrorMessage(cause, requestedProductId ? "商品审核数据暂不可用" : undefined));
      setItems([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, [requestedProductId]);

  useEffect(() => { if (user?.role !== "viewer") void load(); }, [load, user?.role]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => `${item.id} ${valueFor(item, "productName")} ${valueFor(item, "category")} ${valueFor(item, "group")}`.toLowerCase().includes(normalized));
  }, [items, query]);

  const selected = items.find((item) => item.id === selectedId) || null;
  const savedSelectedProduct = selected?.source === "catalog" && selected.product
    ? savedCatalogProducts[selected.product.id]
    : undefined;
  const effectiveSelectedProduct = savedSelectedProduct && selected?.product && savedSelectedProduct.revision >= selected.product.revision
    ? savedSelectedProduct
    : selected?.product;

  useEffect(() => {
    setSelectedImageIndex(0);
    if (!selected) { setDraft({}); return; }
    const next: Record<string, string> = {};
    fieldLabels.forEach(({ key }) => { next[key] = valueFor(selected, key); });
    setDraft(next);
    setDecision(null);
    setReason("");
    setActionError(null);
  }, [selected]);

  async function submitDecision() {
    if (!selected || !decision) return;
    if (decision === "reject" && !window.confirm("确认删除这条待审核记录？\n\n该记录会从待审核队列移除，但原图、AI 证据和审核历史仍会保留。")) return;
    setSaving(true);
    setActionError(null);
    try {
      const reviewReason = decision === "needs_changes" ? `需要修改：${reason.trim()}` : reason.trim() || undefined;
      if (selected.source === "catalog" && selected.product) {
        const productForEdit = effectiveSelectedProduct || selected.product;
        const revision = Number.isSafeInteger(productForEdit.revision) ? productForEdit.revision : undefined;
        if (decision === "approve") {
          await apiJson(`/api/v1/review/items/${encodeURIComponent(productForEdit.id)}/decision`, "POST", { decision, reason: reviewReason, revision, product: productInputFromDraft(productForEdit, draft) });
        } else {
          await apiJson(`/api/v1/review/items/${encodeURIComponent(productForEdit.id)}/decision`, "POST", { decision, reason: reviewReason, revision });
        }
      } else {
        await apiJson("/api/v1/reviews", "POST", {
          itemId: selected.id,
          action: decision,
          ...(decision === "approve" ? {
            category: draft.category,
            group: draft.group,
            backLabel: {
              productName: draft.productName,
              sku: draft.sku,
              barcode: draft.barcode,
              netContent: draft.netContent,
              ingredients: draft.ingredients,
              allergens: draft.allergens,
              manufacturer: draft.manufacturer,
              countryOfOrigin: draft.countryOfOrigin,
              expiry: draft.expiry,
            },
          } : {}),
          // The pipeline candidate may expose its linked product revision;
          // the server must validate it atomically with the human edit.
          ...(Number.isSafeInteger(selected.revision) ? { revision: selected.revision } : {}),
          reason: reviewReason,
        });
      }

      if (decision === "needs_changes") {
        await load();
      } else {
        setItems((current) => current.filter((item) => item.id !== selected.id));
        setSelectedId(null);
      }
      setDecision(null);
      setReason("");
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "审核决定未提交；商品和审核修改均未保存"));
    } finally {
      setSaving(false);
    }
  }

  async function createGroup(name: string) {
    if (!selected || selected.source === "catalog" || !name.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const payload = await apiJson<unknown>("/api/v1/groups", "POST", { name: name.trim(), itemIds: [selected.id], category: draft.category || undefined });
      const created = payload && typeof payload === "object" && "group" in payload ? (payload as { group?: GroupRecord }).group : undefined;
      if (created) setGroups((current) => [...current, created]);
      setDraft((current) => ({ ...current, group: created?.name || name.trim() }));
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "分组创建失败，服务端未确认"));
    } finally {
      setSaving(false);
    }
  }

  if (user?.role === "viewer") return <Notice tone="warning">只读账号不能进入人工审核。服务端会继续拒绝审核和发布请求。</Notice>;

  return (
    <>
      <SectionHeader eyebrow="HUMAN REVIEW" title="人工审核" description="逐字段确认 AI 建议、证据和候选分组。只有服务端记录审核决定后，商品才可能进入发布流程。" actions={<button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshIcon size={15} />刷新队列</button>} />
      <Notice tone="info"><ReviewIcon size={16} />AI 结果始终标记为建议；置信度低、字段冲突或模型不可用的条目需要人工处理。</Notice>
      {requestedProductId && !error && <Notice tone="info">已定位商品 {requestedProductId}。审核提交会携带当前修订版并保留人工修改。</Notice>}
      {actionError && !selected && <Notice tone="warning">{actionError}</Notice>}
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : loading ? <LoadingBlock label="正在读取待审核条目…" /> : items.length === 0 ? <EmptyState title="审核队列为空" description="当前没有等待人工决定的商品。导入任务完成后，候选条目会出现在这里。" /> : <div className="review-layout"><section className="card"><div className="card-header"><div><h2>待处理条目 <span className="muted">({filtered.length})</span></h2><p>未确认前不会显示“已发布”</p></div><input className="input" style={{ maxWidth: 220 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称 / 分组" aria-label="搜索待审核条目" /></div>{groupError && <div className="card-body" style={{ paddingBottom: 0 }}><Notice tone="warning">{groupError}，仍可手动填写分组名称。</Notice></div>}<div>{filtered.length === 0 ? <EmptyState title="没有匹配条目" description="尝试更换搜索关键词。" /> : filtered.map((item) => { const selectedItem = item.id === selectedId; return <button type="button" className={`review-item review-item-select${selectedItem ? " review-item-selected" : ""}`} key={`${item.source}-${item.id}`} onClick={() => setSelectedId(item.id)} aria-pressed={selectedItem}><div className="review-item-head"><div className="review-item-title"><strong>{valueFor(item, "productName") || "未命名商品"}</strong><span>{valueFor(item, "category") || "未分类"} · {valueFor(item, "group") || "未分组"}{item.source === "catalog" ? " · 商品修订" : " · 导入候选"}</span></div><StatusBadge status={item.status || (item.manualRequired ? "needs_review" : "review_pending")} /></div><div className="confidence"><ProgressBar value={typeof item.confidence === "number" ? item.confidence * 100 : undefined} label={typeof item.confidence === "number" ? `${Math.round(item.confidence * 100)}%` : "待确认"} /><span>{item.evidence?.some((entry) => entry.state === "conflict") ? "存在字段冲突" : item.source === "catalog" ? "目录审核" : item.manualRequired ? "需要人工确认" : "AI 建议"}</span></div></button>; })}</div></section><ReviewDetail item={selected} revisionOverride={effectiveSelectedProduct?.revision} draft={draft} setDraft={setDraft} groups={groups} selectedImageIndex={selectedImageIndex} setSelectedImageIndex={setSelectedImageIndex} decision={decision} setDecision={setDecision} reason={reason} setReason={setReason} saving={saving} actionError={actionError} onCreateGroup={createGroup} onSubmit={submitDecision} /></div>}
    </>
  );
}

function ReviewDetail({ item, revisionOverride, draft, setDraft, groups, selectedImageIndex, setSelectedImageIndex, decision, setDecision, reason, setReason, saving, actionError, onCreateGroup, onSubmit }: { item: ReviewCandidate | null; revisionOverride?: number; draft: Record<string, string>; setDraft: (value: Record<string, string>) => void; groups: GroupRecord[]; selectedImageIndex: number; setSelectedImageIndex: (value: number) => void; decision: "approve" | "reject" | "needs_changes" | null; setDecision: (value: "approve" | "reject" | "needs_changes" | null) => void; reason: string; setReason: (value: string) => void; saving: boolean; actionError: string | null; onCreateGroup: (name: string) => Promise<void>; onSubmit: () => Promise<void> }) {
  if (!item) return <aside className="card"><EmptyState title="选择一个条目" description="从左侧队列选择条目查看图片、证据和可编辑字段。" /></aside>;
  if (revisionOverride !== undefined && item.source === "catalog") item = { ...item, revision: revisionOverride };
  const images = (item.images || []).filter((image) => safeImageUrl(image.thumbnailUrl || image.previewUrl));
  const activeIndex = Math.min(Math.max(selectedImageIndex, 0), Math.max(images.length - 1, 0));
  const activeImage = images[activeIndex];
  const activeImageUrl = safeImageUrl(activeImage?.previewUrl || activeImage?.thumbnailUrl);
  return <aside className="card review-side"><div className="card-header"><div><h2>审核详情</h2><p className="mono">{productIdFor(item) || item.id}</p><p className="table-secondary">{item.source === "catalog" ? `商品修订 ${item.revision ?? "未知"}` : "导入候选 / AI 建议"}</p></div><StatusBadge status={item.status || "needs_review"} /></div><div className="card-body"><div className="review-gallery"><div className="review-image">{activeImageUrl ? <img src={activeImageUrl} alt={activeImage?.alt || `${valueFor(item, "productName") || "商品"} 第 ${activeIndex + 1} 张预览`} /> : <div aria-label="暂无预览图">暂无受控预览</div>}</div>{images.length > 1 && <div className="review-thumbnails" aria-label="商品多角度图片">{images.map((image, index) => { const url = safeImageUrl(image.thumbnailUrl || image.previewUrl); return <button type="button" className={`review-thumbnail${index === activeIndex ? " review-thumbnail-active" : ""}`} key={`${image.id || index}`} onClick={() => setSelectedImageIndex(index)} aria-label={`查看第 ${index + 1} 张图片`} aria-pressed={index === activeIndex}>{url ? <img src={url} alt="" /> : index + 1}</button>; })}</div>}</div><dl className="review-fields">{fieldLabels.filter(({ key }) => key !== "group").map(({ key, label }) => <div className="review-field" key={key}><dt>{label}</dt><dd><input className="input" value={draft[key] || ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} aria-label={label} /></dd></div>)}</dl>{item.source === "catalog" ? <Notice tone="info">该条目来自商品审核队列；字段修改只会在审核通过时保存，退回或删除不会改动商品内容。</Notice> : <GroupEditor value={draft.group || ""} groups={groups} saving={saving} onChange={(value) => setDraft({ ...draft, group: value })} onCreate={onCreateGroup} />}{item.source === "catalog" && item.product?.sourceGroupId && <p className="field-hint">来源分组：{item.product.sourceGroupId}</p>}{item.evidence && item.evidence.length > 0 ? <div className="evidence-list"><h3>字段证据（{item.evidence.length}）</h3>{item.evidence.map((evidence, index) => <div className="evidence-row evidence-row-detail" key={`${evidence.fieldKey}-${index}`}><div className="evidence-main"><strong>{evidence.fieldKey}</strong><span>原始：{evidence.rawValue || "—"}</span><span>规范化：{evidence.normalizedValue || "—"}</span></div><div className="evidence-meta"><span>{evidence.source || "未知来源"}</span><span>置信度 {formatConfidence(evidence.confidence)}</span>{evidence.sourceAssetIds && evidence.sourceAssetIds.length > 0 && <span>素材 {evidence.sourceAssetIds.map((id) => id.slice(0, 8)).join("、")}</span>}{formatRegion(evidence.sourceRegion) && <span>{formatRegion(evidence.sourceRegion)}</span>}<StatusBadge status={evidence.state || "suggested"} label={evidence.state === "conflict" ? "冲突" : evidence.state === "accepted" ? "已接受" : evidence.state === "rejected" ? "已拒绝" : evidence.state === "not_found" ? "未找到" : "建议"} /></div></div>)}</div> : item.source === "catalog" ? <Notice tone="warning">暂无字段证据，请结合所有图片和原始资料人工核验。</Notice> : null}{item.error?.message && <Notice tone="danger"><AlertIcon size={15} />{item.error.message}</Notice>}{actionError && <Notice tone="danger">{actionError}</Notice>}<div className="review-actions"><span className="muted" style={{ fontSize: 11 }}>只有审核通过会保存字段修改</span></div><div className="decision-box"><h3>审核决定</h3><div className="decision-buttons"><button type="button" className={`decision-button decision-approve${decision === "approve" ? " decision-selected" : ""}`} onClick={() => setDecision("approve")}>通过并进入发布</button><button type="button" className={`decision-button decision-changes${decision === "needs_changes" ? " decision-selected" : ""}`} onClick={() => setDecision("needs_changes")}>退回修改</button><button type="button" className={`decision-button decision-reject${decision === "reject" ? " decision-selected" : ""}`} onClick={() => setDecision("reject")}>删除条目</button></div>{decision && <><label className="field" htmlFor="decision-reason"><span>处理意见（可选）</span><textarea id="decision-reason" className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可填写本次审核依据或后续处理建议" /></label><button className="button button-primary" type="button" onClick={() => void onSubmit()} disabled={saving}>{saving ? "提交中…" : decision === "reject" ? "确认删除条目" : "确认提交审核决定"}</button></>}</div></div></aside>;
}

function GroupEditor({ value, groups, saving, onChange, onCreate }: { value: string; groups: GroupRecord[]; saving: boolean; onChange: (value: string) => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return <div className="group-editor"><label className="field" htmlFor="review-group"><span>候选分组</span><select id="review-group" className="select" value={value} onChange={(event) => onChange(event.target.value)}><option value="">未分组</option>{groups.map((group) => <option value={group.name} key={group.id}>{group.name}（{Array.isArray(group.itemIds) ? group.itemIds.length : 0}）</option>)}</select></label><div className="group-create"><input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="新分组名称" aria-label="新分组名称" /><button className="button button-secondary" type="button" disabled={saving || !name.trim()} onClick={async () => { await onCreate(name); setName(""); }}>创建并加入</button></div></div>;
}

export default function ReviewPage() {
  return <AppShell active="/review"><ReviewContent /></AppShell>;
}
