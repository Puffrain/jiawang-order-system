"use client";
/* Preview URLs are signed API paths or deployment-approved HTTPS URLs; using
 * plain img keeps the image host configurable for an internal deployment. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryRecord, ProductRecord, ProductStatus } from "../../lib/contracts/catalog";
import { AppShell, useSession } from "../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson, asList } from "../../components/api-client";
import { CatalogIcon, DownloadIcon, PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from "../../components/icon";
import { EmptyState, ErrorState, LoadingBlock, Notice, SectionHeader, StatusBadge } from "../../components/ui";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";

const statusFilters: Array<{ value: "all" | ProductStatus; label: string }> = [
  { value: "all", label: "全部" },
  { value: "published", label: "已发布" },
  { value: "review_pending", label: "待审核" },
  { value: "needs_changes", label: "退回修改" },
  { value: "approved", label: "已审核" },
  { value: "draft", label: "草稿" },
  { value: "rejected", label: "已拒绝" },
];

function safeImageUrl(url?: string | null) {
  if (!url) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return url.startsWith(`${basePath}/`) ? url : `${basePath}${url}`;
  if (url.startsWith("https://")) return url;
  return undefined;
}

function ProductCard({ product, canEdit, onSelect, onDelete, onUnpublish }: { product: ProductRecord & { previewUrl?: string; thumbnailUrl?: string }; canEdit: boolean; onSelect: () => void; onDelete: () => void; onUnpublish?: () => void }) {
  const image = safeImageUrl(product.thumbnailUrl || product.previewUrl);
  const firstVariant = product.variants?.[0];
  const reviewable = product.status === "draft" || product.status === "review_pending" || product.status === "needs_changes";
  const syncLabel = product.orderSyncStatus === "delivered" ? "已进入订单系统" : product.orderSyncStatus === "dead" ? "同步失败" : product.orderSyncStatus === "pending" ? "待同步" : null;
  return <article className="product-card"><div className="product-thumb">{image ? <img src={image} alt={`${product.name} 商品图`} /> : <CatalogIcon size={33} />}</div><div className="product-body"><h3 title={product.name}>{product.name || "未命名商品"}</h3><div className="product-meta"><span>{product.brand || "未填写品牌"}</span><StatusBadge status={product.status} label={product.status === "approved" ? "已审核待发布" : undefined} /></div>{syncLabel&&<p className={`product-spec ${product.orderSyncStatus==="dead"?"text-danger":""}`} title={product.orderSyncError||undefined}>订单同步：{syncLabel}{product.orderSyncStatus==="pending"&&product.orderSyncAttempts?`（已重试 ${product.orderSyncAttempts} 次）`:""}</p>}<p className="product-spec">{firstVariant?.specification || "规格待补充"}{firstVariant?.sku ? ` · SKU ${firstVariant.sku}` : ""}</p><div className="product-actions"><button className="button button-quiet" type="button" onClick={onSelect}>查看详情</button>{canEdit && product.status === "published" && <><a className="button button-secondary" href={basePath + "/catalog/new?edit=" + encodeURIComponent(product.id)}>编辑商品</a><button className="button button-danger" type="button" onClick={onUnpublish}>停售商品</button></>}{canEdit && (product.status === "draft" || product.status === "needs_changes") && <a className="button button-secondary" href={basePath + "/catalog/new?edit=" + encodeURIComponent(product.id)}>{product.status === "draft" ? "修改草稿" : "继续修改"}</a>}{canEdit && product.status === "rejected" && <button className="button button-danger" type="button" onClick={onDelete}><TrashIcon size={15} />删除条目</button>}{canEdit && reviewable && <a className="button button-secondary" href={`/warehouse/review?product=${encodeURIComponent(product.id)}`}>去审核</a>}</div></div></article>;
}

function CatalogContent() {
  const { user } = useSession();
  const [products, setProducts] = useState<Array<ProductRecord & { previewUrl?: string; thumbnailUrl?: string }>>([]);
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [selected, setSelected] = useState<ProductRecord | null>(null);
  const [status, setStatus] = useState<"all" | ProductStatus>(user?.role === "viewer" ? "published" : "all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // Keep the read-only boundary explicit even if a session role changes
      // while this page remains mounted.
      const effectiveStatus = user?.role === "viewer" ? "published" : status;
      const suffix = effectiveStatus === "all" ? "?status=all" : `?status=${encodeURIComponent(effectiveStatus)}`;
      const payload = await apiFetch<unknown>(`/api/v1/catalog/products${suffix}`, { cache: "no-store" });
      setProducts(asList<ProductRecord & { previewUrl?: string; thumbnailUrl?: string }>(payload, ["products", "items", "records"]));
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setProducts([]);
    } finally { setLoading(false); }
  }, [status, user?.role]);

  const loadCategories = useCallback(async () => {
    setCategoryError(null);
    try {
      const payload = await apiFetch<unknown>("/api/v1/taxonomy", { cache: "no-store" });
      setCategories(asList<CategoryRecord>(payload, ["categories", "items", "records"]));
    } catch (cause) { setCategoryError(apiErrorMessage(cause)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCategories(); }, [loadCategories]);

  async function unpublishProduct(product: ProductRecord) {
    if (product.status !== "published" || !window.confirm("确认停售这个商品？停售会立即从买家端隐藏，并保留历史订单记录。")) return;
    setBusyProductId(product.id); setError(null);
    try {
      await apiFetch("/api/v1/catalog/products/" + encodeURIComponent(product.id), { method: "DELETE" });
      setProducts((current) => current.map((item) => item.id === product.id ? { ...item, status: "needs_changes" } : item));
      setSelected((current) => current?.id === product.id ? { ...current, status: "needs_changes" } : current);
    } catch (cause) { setError(apiErrorMessage(cause, "停售商品失败")); }
    finally { setBusyProductId(null); }
  }

  async function deleteProduct(product: ProductRecord) {
    if (product.status !== "rejected" || !window.confirm("确认删除这条已拒绝商品？")) return;
    setBusyProductId(product.id); setError(null);
    try {
      await apiFetch("/api/v1/catalog/products/" + encodeURIComponent(product.id), { method: "DELETE" });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      setSelected((current) => current?.id === product.id ? null : current);
    } catch (cause) { setError(apiErrorMessage(cause, "删除商品失败")); }
    finally { setBusyProductId(null); }
  }

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return products;
    return products.filter((product) => `${product.name} ${product.brand || ""} ${product.categoryId} ${product.variants?.map((v) => `${v.sku || ""} ${v.barcodeNormalized || v.barcodeRaw || ""}`).join(" ")}`.toLowerCase().includes(normalized));
  }, [products, query]);

  async function exportPublished() {
    setExporting(true); setExportError(null);
    try {
      const created = await apiJson<unknown>("/api/v1/exports", "POST", { format: "csv" });
      const exportId = created && typeof created === "object" && "job" in created && (created as { job?: { id?: string } }).job?.id;
      if (typeof exportId !== "string") throw new Error("服务端没有返回导出任务 ID");
      // Export generation runs in the durable worker. Poll the small job
      // record, then let the browser stream the attachment directly instead
      // of copying the whole file into a Blob/renderer heap.
      let completed = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const payload = await apiFetch<unknown>("/api/v1/exports", { cache: "no-store" });
        const jobs = asList<{ id: string; status: string; errorMessage?: string | null }>(payload, ["exports", "items", "records"]);
        const current = jobs.find((job) => job.id === exportId);
        if (!current) continue;
        if (current.status === "failed") throw new Error(current.errorMessage || "导出失败，请稍后重试");
        if (current.status === "completed") { completed = true; break; }
      }
      if (!completed) throw new Error("导出仍在队列中，请稍后在任务列表下载");
      const anchor = document.createElement("a");
      anchor.href = `${basePath}/api/v1/exports/${encodeURIComponent(exportId)}/download`;
      anchor.download = `佳旺商品库-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch (cause) { setExportError(apiErrorMessage(cause, "导出未完成，服务端没有确认文件生成")); }
    finally { setExporting(false); }
  }

  const categoryName = (id: string) => categories.find((category) => category.id === id)?.name || id || "未分类";

  return <>
    <SectionHeader eyebrow="CATALOG" title="商品库" description="查看结构化商品资料。默认导出范围仅包含已发布数据，待审核和草稿不会混入结果。" actions={<>{user?.role !== "viewer" && <a className="button button-primary" href={basePath + "/catalog/new"}><PlusIcon size={15} />人工新增商品</a>}<button className="button button-secondary" type="button" onClick={() => { void load(); void loadCategories(); }} disabled={loading}><RefreshIcon size={15} />刷新</button><button className="button button-secondary" type="button" onClick={() => void exportPublished()} disabled={exporting}><DownloadIcon size={15} />{exporting ? "生成中…" : "导出已发布 CSV"}</button></>} />
    {exportError && <Notice tone="danger">{exportError}</Notice>}
    {user?.role === "viewer" && <Notice tone="info">只读账号只能查看已发布商品；编辑、审核、备份等操作已隐藏，服务端仍会再次校验权限。</Notice>}
    <section className="card"><div className="card-header"><div><h2>商品列表</h2><p>{filtered.length} 条记录 · 分类 {categories.length || "—"}</p></div><div className="toolbar" style={{ margin: 0 }}><div className="search-wrap"><SearchIcon size={15} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、品牌或 SKU" aria-label="搜索商品" /></div></div></div><div className="filter-tabs" role="tablist" aria-label="商品状态筛选">{statusFilters.filter((filter) => user?.role !== "viewer" || filter.value === "published").map((filter) => <button key={filter.value} type="button" role="tab" aria-selected={status === filter.value} className={`filter-tab${status === filter.value ? " filter-tab-active" : ""}`} onClick={() => setStatus(filter.value)}>{filter.label}</button>)}</div><div className="card-body">{loading ? <LoadingBlock label="正在读取商品库…" /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : filtered.length === 0 ? <div className="catalog-empty"><EmptyState title={query ? "没有匹配的商品" : "商品库为空"} description={query ? "尝试更换关键词或清除筛选条件。" : status === "published" ? "审核通过并发布的商品会出现在这里。" : "完成导入和审核后，商品会出现在这里。"} /></div> : <div className="catalog-grid">{filtered.map((product) => <ProductCard key={product.id} product={product} canEdit={user?.role !== "viewer"} onSelect={() => setSelected(product)} onDelete={() => { if (!busyProductId) void deleteProduct(product); }} onUnpublish={() => { if (!busyProductId) void unpublishProduct(product); }} />)}</div>}</div></section>
    <section className="card category-card"><div className="card-header"><div><h2>类目字典</h2><p>AI 建议只能选择已配置的类目，发布前会再次校验</p></div>{user?.role === "admin" && <a className="button button-secondary" href="/settings?tab=categories">管理类目</a>}</div>{categoryError ? <div className="card-body"><Notice tone="warning">类目接口暂不可用：{categoryError}</Notice></div> : categories.length === 0 ? <div className="card-body"><EmptyState title="暂无类目数据" description="请由管理员在系统设置中维护类目。" /></div> : <div className="category-list">{categories.filter((category) => category.active).slice(0, 20).map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}</div>}</section>
    {selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="product-detail-title"><div className="card-header"><div><h2 id="product-detail-title">{selected.name || "未命名商品"}</h2><p>{categoryName(selected.categoryId)} · 修订版 {selected.revision}</p></div><button className="icon-button" type="button" aria-label="关闭详情" onClick={() => setSelected(null)}>×</button></div><div className="card-body"><dl className="detail-grid"><div><dt>品牌</dt><dd>{selected.brand || "未填写"}</dd></div><div><dt>状态</dt><dd><StatusBadge status={selected.status} label={selected.status === "approved" ? "已审核待发布" : undefined} /></dd></div><div><dt>生产商</dt><dd>{selected.manufacturer || "未填写"}</dd></div><div><dt>原产地</dt><dd>{selected.countryOfOrigin || "未填写"}</dd></div><div className="detail-wide"><dt>描述</dt><dd className="detail-preserve-lines">{selected.description || "未填写"}</dd></div></dl>{selected.variants?.length > 0 && <div className="table-wrap"><table className="data-table"><thead><tr><th>规格</th><th>SKU</th><th>条码</th><th>库存</th></tr></thead><tbody>{selected.variants.map((variant, index) => <tr key={variant.id || index}><td data-label="规格">{variant.specification}</td><td data-label="SKU">{variant.sku || "—"}</td><td data-label="条码" className="mono">{variant.barcodeNormalized || variant.barcodeRaw || "—"}</td><td data-label="库存">{variant.stock ?? "—"}</td></tr>)}</tbody></table></div>}</div></section></div>}
  </>;
}

export default function CatalogPage() {
  return <AppShell active="/catalog"><CatalogContent /></AppShell>;
}



