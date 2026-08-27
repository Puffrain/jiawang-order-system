"use client";
/* Product images are controlled local blob URLs or authenticated media URLs. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell, useSession } from "../../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson, asList } from "../../../components/api-client";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, ImageIcon, PlusIcon, SaveIcon, TrashIcon } from "../../../components/icon";
import { Notice, SectionHeader, StatusBadge } from "../../../components/ui";
import type { CategoryRecord, ProductRecord } from "../../../lib/contracts/catalog";
import { generateColorVariants as buildColorVariants } from "../../../lib/bulk-color-variants";
import { FormattedDescription } from "../../../components/formatted-description";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

type SubmitMode = "draft" | "review";
type UploadStatus = "ready" | "uploading" | "prepared" | "failed";

interface ImageEntry {
  localId: string;
  file?: File;
  previewUrl: string;
  status: UploadStatus;
  progress: number;
  assetId?: string;
  label?: string;
  error?: string;
}

interface VariantForm {
  localId: string;
  id?: string;
  specification: string;
  sku: string;
  barcodeRaw: string;
  netContent: string;
  unit: string;
  packaging: string;
  color: string;
  scent: string;
  price: string;
  stock: string;
}

interface ProductForm {
  name: string;
  brand: string;
  categoryId: string;
  subcategoryId: string;
  description: string;
  ingredients: string;
  efficacy: string;
  directions: string;
  warnings: string;
  countryOfOrigin: string;
  manufacturer: string;
  licenseNumber: string;
  batchNumber: string;
  productionDate: string;
  shelfLife: string;
  expiryDate: string;
  notes: string;
}

const emptyForm: ProductForm = {
  name: "", brand: "", categoryId: "", subcategoryId: "", description: "", ingredients: "", efficacy: "", directions: "", warnings: "", countryOfOrigin: "", manufacturer: "", licenseNumber: "", batchNumber: "", productionDate: "", shelfLife: "", expiryDate: "", notes: "",
};

function localId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function emptyVariant(): VariantForm {
  return { localId: localId("variant"), specification: "", sku: "", barcodeRaw: "", netContent: "", unit: "", packaging: "", color: "", scent: "", price: "", stock: "" };
}

function nestedId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const nested = record[key];
  return nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string" ? (nested as { id: string }).id : undefined;
}

async function digest(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const hash = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function optionalNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value);
}

function ManualProductContent() {
  const { user } = useSession();
  const searchParams = useSearchParams();
  const editProductId = searchParams.get("edit");
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [variants, setVariants] = useState<VariantForm[]>([emptyVariant()]);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ProductRecord | null>(null);
  const [busyMode, setBusyMode] = useState<SubmitMode | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState(variants[0].localId);
  const [bulkColors, setBulkColors] = useState("");
  const [editingProduct, setEditingProduct] = useState<ProductRecord | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(Boolean(editProductId));
  const previewUrls = useRef(new Set<string>());
  const dirtyRef = useRef(false);

  const loadCategories = useCallback(async () => {
    try {
      const payload = await apiFetch<unknown>("/api/v1/taxonomy?all=true", { cache: "no-store" });
      setCategories(asList<CategoryRecord>(payload, ["categories", "items", "records"]));
    } catch (cause) { setCategoryError(apiErrorMessage(cause)); }
  }, []);

  useEffect(() => { void loadCategories(); }, [loadCategories]);
  useEffect(() => {
    if (!editProductId) return;
    const productId = editProductId;
    let cancelled = false;
    async function loadProduct() {
      setLoadingProduct(true); setError(null);
      try {
        const payload = await apiFetch<unknown>(`/api/v1/catalog/products/${encodeURIComponent(productId)}`, { cache: "no-store" });
        const product = payload && typeof payload === "object" && "product" in payload ? (payload as { product?: ProductRecord }).product : undefined;
        if (!product) throw new Error("未找到需要修改的商品");
        if (product.entrySource !== "manual" || !["needs_changes", "published"].includes(product.status)) throw new Error("只有人工商品可以从这里继续编辑");
        if (cancelled) return;
        setEditingProduct(product);
        setForm({ name: product.name || "", brand: product.brand || "", categoryId: product.categoryId || "", subcategoryId: product.subcategoryId || "", description: product.description || "", ingredients: product.ingredients || "", efficacy: product.efficacy || "", directions: product.directions || "", warnings: product.warnings || "", countryOfOrigin: product.countryOfOrigin || "", manufacturer: product.manufacturer || "", licenseNumber: product.licenseNumber || "", batchNumber: product.batchNumber || "", productionDate: product.productionDate || "", shelfLife: product.shelfLife || "", expiryDate: product.expiryDate || "", notes: product.notes || "" });
        const restoredVariants = product.variants.map((variant) => ({ localId: localId("variant"), id: variant.id, specification: variant.specification || "", sku: variant.sku || "", barcodeRaw: variant.barcodeRaw || "", netContent: variant.netContent || "", unit: variant.unit || "", packaging: variant.packaging || "", color: variant.color || "", scent: variant.scent || "", price: variant.price == null ? "" : String(variant.price), stock: variant.stock == null ? "" : String(variant.stock) }));
        setVariants(restoredVariants.length ? restoredVariants : [emptyVariant()]);
        setSelectedVariantId(restoredVariants[0]?.localId || "");
        // Product records retain original uploads for evidence, but edits may
        // only submit their processed derivatives back to the catalog.
        const editableAssetIds = product.publishedAssetIds?.length ? product.publishedAssetIds : product.assetIds || [];
        setImages(editableAssetIds.map((assetId, index) => ({ localId: localId("image"), previewUrl: `${basePath}/api/v1/media/${encodeURIComponent(assetId)}`, status: "prepared", progress: 100, assetId, label: `已保存图片 ${index + 1}` })));
        dirtyRef.current = false;
        setDirty(false);
      } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause, "商品资料无法读取")); }
      finally { if (!cancelled) setLoadingProduct(false); }
    }
    void loadProduct();
    return () => { cancelled = true; };
  }, [editProductId]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  useEffect(() => {
    const urls = previewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }, []);

  const topCategories = useMemo(() => categories.filter((category) => category.active && !category.parentId), [categories]);
  const subcategories = useMemo(() => categories.filter((category) => category.active && category.parentId === form.categoryId), [categories, form.categoryId]);
  const selectedVariant = variants.find((variant) => variant.localId === selectedVariantId) || variants[0];
  const numericPrices = variants.filter((variant) => variant.price !== "").map((variant) => Number(variant.price)).filter((price) => Number.isFinite(price) && price >= 0);
  const lowPrice = numericPrices.length ? Math.min(...numericPrices) : 0;
  const highPrice = numericPrices.length ? Math.max(...numericPrices) : 0;
  const currentCategory = categories.find((category) => category.id === form.subcategoryId) || categories.find((category) => category.id === form.categoryId);

  function setField<K extends keyof ProductForm>(key: K, value: ProductForm[K]) {
    dirtyRef.current = true;
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value, ...(key === "categoryId" ? { subcategoryId: "" } : {}) }));
  }

  function setVariant(localIdValue: string, patch: Partial<VariantForm>) {
    dirtyRef.current = true;
    setDirty(true);
    setVariants((current) => current.map((variant) => variant.localId === localIdValue ? { ...variant, ...patch } : variant));
  }

  function addVariant() {
    const next = emptyVariant();
    setVariants((current) => [...current, next]);
    setSelectedVariantId(next.localId);
    dirtyRef.current = true;
    setDirty(true);
  }

  function generateColorVariants() {
    if (!bulkColors.trim()) {
      setError("请先填写至少一个颜色，每行一个或用逗号分隔");
      return;
    }
    const template = selectedVariant || variants[0] || emptyVariant();
    const result = buildColorVariants({ existing: variants, template, colorText: bulkColors, createId: () => localId("variant") });
    if (!result.colors.length) {
      setError("请先填写至少一个颜色，每行一个或用逗号分隔");
      return;
    }
    if (!result.generated.length) {
      setError("这些颜色已存在，或规格数量已经达到 100 个");
      return;
    }
    setVariants(result.variants);
    setSelectedVariantId(result.generated[0].localId);
    setBulkColors("");
    setError(null);
    dirtyRef.current = true;
    setDirty(true);
  }

  function removeVariant(localIdValue: string) {
    if (variants.length === 1) return;
    const next = variants.filter((variant) => variant.localId !== localIdValue);
    setVariants(next);
    if (selectedVariantId === localIdValue) setSelectedVariantId(next[0].localId);
    dirtyRef.current = true;
    setDirty(true);
  }

  function addImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    setError(null);
    const accepted: ImageEntry[] = [];
    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("仅支持 JPEG、PNG 和 WebP 图片"); continue; }
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) { setError(`${file.name} 超过 15 MB 或为空文件`); continue; }
      if (images.length + accepted.length >= MAX_IMAGES) { setError("商品图片最多 8 张"); break; }
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      accepted.push({ localId: localId("image"), file, previewUrl, status: "ready", progress: 0 });
    }
    if (accepted.length) { dirtyRef.current = true; setImages((current) => [...current, ...accepted]); setDirty(true); }
  }

  function removeImage(localIdValue: string) {
    const image = images.find((item) => item.localId === localIdValue);
    if (image) { URL.revokeObjectURL(image.previewUrl); previewUrls.current.delete(image.previewUrl); }
    setImages((current) => current.filter((item) => item.localId !== localIdValue));
    dirtyRef.current = true;
    setDirty(true);
  }

  function moveImage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    setImages((current) => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
    dirtyRef.current = true;
    setDirty(true);
  }

  function setPrimaryImage(index: number) {
    if (index <= 0 || index >= images.length) return;
    setImages((current) => [current[index], ...current.slice(0, index), ...current.slice(index + 1)]);
    dirtyRef.current = true;
    setDirty(true);
  }

  function updateImage(localIdValue: string, patch: Partial<ImageEntry>) {
    setImages((current) => current.map((image) => image.localId === localIdValue ? { ...image, ...patch } : image));
  }

  async function uploadImage(image: ImageEntry): Promise<string> {
    if (image.assetId) {
      return image.assetId;
    }
    if (!image.file) throw new Error("图片文件不可用，请重新选择图片");
    updateImage(image.localId, { status: "uploading", progress: 1, error: undefined });
    try {
      const expectedChunks = Math.ceil(image.file.size / CHUNK_BYTES);
      const created = await apiFetch<unknown>("/api/v1/uploads", { method: "POST", body: JSON.stringify({ filename: image.file.name, expectedBytes: image.file.size, expectedChunks, chunkSize: CHUNK_BYTES, mimeType: image.file.type }) });
      const uploadId = nestedId(created, "upload");
      if (!uploadId) throw new Error("服务端没有返回上传会话 ID");
      for (let index = 0; index < expectedChunks; index += 1) {
        const chunk = image.file.slice(index * CHUNK_BYTES, Math.min(image.file.size, (index + 1) * CHUNK_BYTES));
        const chunkDigest = await digest(chunk);
        await apiFetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, { method: "PUT", body: chunk, headers: chunkDigest ? { "x-chunk-sha256": chunkDigest } : undefined });
        updateImage(image.localId, { progress: Math.round(((index + 1) / expectedChunks) * 80) });
      }
      const completed = await apiFetch<unknown>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST", body: JSON.stringify({ sha256: await digest(image.file) }) });
      const sourceAssetId = nestedId(completed, "asset");
      if (!sourceAssetId) throw new Error("服务端没有返回图片 ID");
      updateImage(image.localId, { progress: 88 });
      const prepared = await apiJson<unknown>("/api/v1/catalog/assets/prepare", "POST", { assetId: sourceAssetId });
      const assetId = nestedId(prepared, "asset");
      if (!assetId) throw new Error("图片处理结果无效");
      updateImage(image.localId, { status: "prepared", progress: 100, assetId });
      return assetId;
    } catch (cause) {
      const message = apiErrorMessage(cause, "图片上传失败");
      updateImage(image.localId, { status: "failed", error: message });
      throw new Error(message);
    }
  }

  function validate(mode: SubmitMode): string | null {
    if (!form.name.trim()) return "请填写商品名称";
    if (!form.categoryId) return "请选择一级类目";
    if (!variants.length || variants.some((variant) => !variant.specification.trim())) return "每个规格都必须填写规格名称";
    const skus = variants.map((variant) => variant.sku.trim().toUpperCase()).filter(Boolean);
    if (new Set(skus).size !== skus.length) return "同一商品内 SKU 不能重复";
    const barcodes = variants.map((variant) => variant.barcodeRaw.trim().toUpperCase()).filter(Boolean);
    if (new Set(barcodes).size !== barcodes.length) return "同一商品内商品条码不能重复";
    if (variants.some((variant) => variant.price !== "" && (!Number.isFinite(Number(variant.price)) || Number(variant.price) < 0))) return "价格必须为非负数字";
    if (variants.some((variant) => variant.stock !== "" && (!Number.isSafeInteger(Number(variant.stock)) || Number(variant.stock) < 0))) return "库存必须为非负整数";
    if (mode === "review" && images.length === 0) return "提交审核前至少需要一张商品图片";
    if (mode === "review" && variants.some((variant) => variant.price === "" || variant.stock === "")) return "提交审核前请填写每个规格的价格和库存";
    return null;
  }

  async function save(mode: SubmitMode) {
    const problem = validate(mode);
    if (problem) { setError(problem); return; }
    setBusyMode(mode); setError(null);
    try {
      const assetIds: string[] = [];
      for (const image of images) assetIds.push(await uploadImage(image));
      const payload = {
        ...form,
        subcategoryId: form.subcategoryId || null,
        assetIds,
        publish: mode === "review",
        variants: variants.map(({ localId: _localId, price, stock, ...variant }) => ({ ...variant, price: optionalNumber(price), stock: optionalNumber(stock) })),
      };
      const created = editingProduct
        ? await apiFetch<unknown>(`/api/v1/catalog/products/${encodeURIComponent(editingProduct.id)}`, { method: "PUT", headers: { "if-match": `\"${editingProduct.revision}\"` }, body: JSON.stringify(payload) })
        : await apiJson<unknown>("/api/v1/catalog/products", "POST", payload);
      const product = created && typeof created === "object" && "product" in created ? (created as { product?: ProductRecord }).product : undefined;
      if (!product) throw new Error("服务端没有返回已保存商品");
      dirtyRef.current = false;
      setSuccess(product); setDirty(false);
      if (mode === "review") window.location.assign(`${basePath}/catalog`);
    } catch (cause) { setError(apiErrorMessage(cause, "商品保存失败")); }
    finally { setBusyMode(null); }
  }

  if (user?.role === "viewer") return <Notice tone="danger">当前账号没有人工新增商品的权限。</Notice>;
  if (loadingProduct) return <Notice tone="info">正在载入退回商品的原始资料…</Notice>;

  return <>
    <SectionHeader eyebrow="MANUAL PRODUCT" title={editingProduct ? "修改退回商品" : "人工新增商品"} description={editingProduct ? "保留原商品、规格和图片，在此修正后再提交审核。" : "完整录入商品资料、图片和销售规格，保存后进入现有审核发布流程。"} actions={<a className="button button-secondary" href={`${basePath}/catalog`}><ArrowLeftIcon size={15} />返回商品库</a>} />
    {categoryError && <Notice tone="warning">类目暂时无法读取：{categoryError}</Notice>}
    {error && <Notice tone="danger">{error}</Notice>}
    {success && <Notice tone="success">商品“{success.name}”已保存为草稿。<a href={`${basePath}/review?product=${encodeURIComponent(success.id)}`}>去审核</a></Notice>}

    <div className="manual-product-layout">
      <div className="manual-product-form">
        <section className="card manual-section"><div className="card-header"><div><h2>基本信息</h2><p>商品名称、品牌和销售类目</p></div><StatusBadge status="draft" label="草稿" /></div><div className="card-body form-grid form-grid-2">
          <Field label="商品名称" required wide><input className="input" value={form.name} maxLength={240} onChange={(event) => setField("name", event.target.value)} placeholder="如 施华蔻专业洗发水 1000ml" /></Field>
          <Field label="品牌"><input className="input" value={form.brand} maxLength={160} onChange={(event) => setField("brand", event.target.value)} placeholder="品牌名称" /></Field>
          <Field label="一级类目" required><select className="select" value={form.categoryId} onChange={(event) => setField("categoryId", event.target.value)}><option value="">请选择</option>{topCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          <Field label="二级类目"><select className="select" value={form.subcategoryId} disabled={!subcategories.length} onChange={(event) => setField("subcategoryId", event.target.value)}><option value="">{subcategories.length ? "不选择" : "暂无二级类目"}</option>{subcategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
          <Field label="商品卖点与描述" wide><div className="description-editor"><div className="description-toolbar"><button type="button" className="button button-quiet" onClick={() => setField("description", form.description ? `**${form.description}**` : "**加粗文字**")}>加粗</button><button type="button" className="button button-quiet text-danger" onClick={() => setField("description", form.description ? `[color=#dc2626]${form.description}[/color]` : "[color=#dc2626]红色文字[/color]")}>红色</button><button type="button" className="button button-quiet text-success" onClick={() => setField("description", form.description ? `[color=#15803d]${form.description}[/color]` : "[color=#15803d]绿色文字[/color]")}>绿色</button><span className="field-hint">支持换行；格式标记也可以直接编辑</span></div><textarea className="textarea" value={form.description} onChange={(event) => setField("description", event.target.value)} placeholder="突出容量、适用发质、核心卖点和使用场景" /><div className="description-preview"><span>预览</span><FormattedDescription text={form.description || "商品卖点和描述会显示在这里"} /></div></div></Field>
        </div></section>

        <section className="card manual-section"><div className="card-header"><div><h2>商品图片</h2><p>{images.length}/{MAX_IMAGES} 张 · 第一张为主图</p></div><label className={`button button-primary${images.length >= MAX_IMAGES || busyMode ? " button-disabled" : ""}`}><ImageIcon size={15} />选择图片<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={images.length >= MAX_IMAGES || Boolean(busyMode)} onChange={addImages} /></label></div><div className="card-body">
          {images.length === 0 ? <label className="manual-image-empty"><ImageIcon size={34} /><strong>添加商品主图和详情图</strong><span>JPEG、PNG、WebP，单张不超过 15 MB</span><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addImages} /></label> : <div className="manual-image-grid">{images.map((image, index) => <article className="manual-image-item" key={image.localId}><div className="manual-image-preview"><img src={image.previewUrl} alt={`商品图 ${index + 1}`} />{index === 0 && <span>主图</span>}</div><div className="manual-image-meta"><strong title={image.file?.name || image.label}>{image.file?.name || image.label || `商品图 ${index + 1}`}</strong><small>{image.status === "uploading" ? `上传处理中 ${image.progress}%` : image.status === "failed" ? image.error : image.status === "prepared" ? "已处理" : "待保存"}</small></div><div className="manual-image-actions"><button className="icon-button" type="button" aria-label="向前移动" title="向前移动" disabled={index === 0 || Boolean(busyMode)} onClick={() => moveImage(index, -1)}><ChevronLeftIcon size={15} /></button><button className="icon-button" type="button" aria-label="向后移动" title="向后移动" disabled={index === images.length - 1 || Boolean(busyMode)} onClick={() => moveImage(index, 1)}><ChevronRightIcon size={15} /></button><button className="icon-button text-danger" type="button" aria-label="删除图片" title="删除图片" disabled={Boolean(busyMode)} onClick={() => removeImage(image.localId)}><TrashIcon size={15} /></button></div></article>)}</div>}
        </div></section>

        <section className="card manual-section"><div className="card-header"><div><h2>销售规格</h2><p>{variants.length} 个规格</p></div><button className="button button-secondary" type="button" onClick={addVariant} disabled={Boolean(busyMode) || variants.length >= 100}><PlusIcon size={15} />添加规格</button></div><div className="card-body variant-editor-list">
          <div className="bulk-variant-tools"><div><strong>批量生成颜色规格</strong><p>先在一条规格里填写价格、库存、净含量、包装等公共信息并选中它，再粘贴颜色；每个颜色会复制这些公共信息并成为独立规格，已有规格不会被覆盖。</p></div><textarea className="textarea" value={bulkColors} onChange={(event) => setBulkColors(event.target.value)} placeholder="例如：黑色\n栗棕色\n6/11 冷棕色" disabled={Boolean(busyMode)} /><div className="bulk-variant-actions"><span>支持换行、逗号、顿号或分号分隔，自动跳过重复颜色，最多 100 个规格</span><button className="button button-secondary" type="button" onClick={generateColorVariants} disabled={Boolean(busyMode)}><PlusIcon size={15} />生成颜色规格</button></div></div>
          {variants.map((variant, index) => <article className={`manual-variant${selectedVariantId === variant.localId ? " manual-variant-template" : ""}`} key={variant.localId} onFocusCapture={() => setSelectedVariantId(variant.localId)}><header><div><span>规格 {index + 1}</span><strong>{variant.specification || "未命名规格"}</strong></div><div className="manual-variant-header-actions"><button className="button button-quiet" type="button" aria-pressed={selectedVariantId === variant.localId} onClick={() => setSelectedVariantId(variant.localId)}>{selectedVariantId === variant.localId ? "公共信息模板" : "设为模板"}</button><button className="icon-button text-danger" type="button" aria-label="删除规格" title="删除规格" disabled={variants.length === 1 || Boolean(busyMode)} onClick={() => removeVariant(variant.localId)}><TrashIcon size={15} /></button></div></header><div className="form-grid manual-variant-grid">
          <Field label="规格名称" required><input className="input" value={variant.specification} maxLength={240} onFocus={() => setSelectedVariantId(variant.localId)} onChange={(event) => setVariant(variant.localId, { specification: event.target.value })} placeholder="如 1000ml / 瓶" /></Field>
          <Field label="SKU 编码"><input className="input" value={variant.sku} maxLength={128} onChange={(event) => setVariant(variant.localId, { sku: event.target.value })} placeholder="可留空自动生成" /></Field>
          <Field label="售价"><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={variant.price} onChange={(event) => setVariant(variant.localId, { price: event.target.value })} placeholder="0.00" /></Field>
          <Field label="库存"><input className="input" type="number" min="0" step="1" inputMode="numeric" value={variant.stock} onChange={(event) => setVariant(variant.localId, { stock: event.target.value })} placeholder="0" /></Field>
          <Field label="商品条码"><input className="input" value={variant.barcodeRaw} maxLength={128} onChange={(event) => setVariant(variant.localId, { barcodeRaw: event.target.value })} placeholder="EAN / UPC / CODE 128" /></Field>
          <Field label="净含量"><input className="input" value={variant.netContent} maxLength={120} onChange={(event) => setVariant(variant.localId, { netContent: event.target.value })} placeholder="如 1000ml" /></Field>
          <Field label="计量单位"><input className="input" value={variant.unit} maxLength={40} onChange={(event) => setVariant(variant.localId, { unit: event.target.value })} placeholder="瓶、盒、支" /></Field>
          <Field label="包装"><input className="input" value={variant.packaging} maxLength={120} onChange={(event) => setVariant(variant.localId, { packaging: event.target.value })} placeholder="瓶装、盒装" /></Field>
          <Field label="颜色"><input className="input" value={variant.color} maxLength={120} onChange={(event) => setVariant(variant.localId, { color: event.target.value })} placeholder="可选" /></Field>
          <Field label="香型"><input className="input" value={variant.scent} maxLength={120} onChange={(event) => setVariant(variant.localId, { scent: event.target.value })} placeholder="可选" /></Field>
        </div></article>)}</div></section>

        <section className="card manual-section"><div className="card-header"><div><h2>商品详情</h2><p>买家判断是否适用的核心资料</p></div></div><div className="card-body form-grid form-grid-2">
          <Field label="主要功效" wide><textarea className="textarea" value={form.efficacy} onChange={(event) => setField("efficacy", event.target.value)} placeholder="清洁、修护、保湿、定型等" /></Field>
          <Field label="成分信息" wide><textarea className="textarea" value={form.ingredients} onChange={(event) => setField("ingredients", event.target.value)} placeholder="按包装标识填写主要成分" /></Field>
          <Field label="使用方法"><textarea className="textarea" value={form.directions} onChange={(event) => setField("directions", event.target.value)} placeholder="用量、步骤和频次" /></Field>
          <Field label="注意事项"><textarea className="textarea" value={form.warnings} onChange={(event) => setField("warnings", event.target.value)} placeholder="过敏提示、储存方式和安全警示" /></Field>
        </div></section>

        <section className="card manual-section"><div className="card-header"><div><h2>生产与资质</h2><p>包装标识和追溯信息</p></div></div><div className="card-body form-grid form-grid-2">
          <Field label="生产商"><input className="input" value={form.manufacturer} onChange={(event) => setField("manufacturer", event.target.value)} /></Field>
          <Field label="原产地"><input className="input" value={form.countryOfOrigin} onChange={(event) => setField("countryOfOrigin", event.target.value)} /></Field>
          <Field label="许可证 / 备案号"><input className="input" value={form.licenseNumber} onChange={(event) => setField("licenseNumber", event.target.value)} /></Field>
          <Field label="生产批次"><input className="input" value={form.batchNumber} maxLength={64} onChange={(event) => setField("batchNumber", event.target.value)} /></Field>
          <Field label="生产日期"><input className="input" type="date" value={form.productionDate} onChange={(event) => setField("productionDate", event.target.value)} /></Field>
          <Field label="有效期至"><input className="input" type="date" value={form.expiryDate} onChange={(event) => setField("expiryDate", event.target.value)} /></Field>
          <Field label="保质期"><input className="input" value={form.shelfLife} maxLength={128} onChange={(event) => setField("shelfLife", event.target.value)} placeholder="如 3 年" /></Field>
        </div></section>

        <section className="card manual-section"><div className="card-header"><div><h2>内部备注</h2><p>仅仓库人员可见，不同步到买家端</p></div></div><div className="card-body"><textarea className="textarea" value={form.notes} onChange={(event) => setField("notes", event.target.value)} placeholder="采购来源、盘点提示、后续补充事项" /></div></section>
      </div>

      <aside className="purchase-preview card" aria-label="买家端预览"><div className="purchase-preview-head"><span>买家端预览</span><StatusBadge status="draft" label="实时" /></div><div className="purchase-preview-image">{images[0] ? <img src={images[0].previewUrl} alt={form.name || "商品预览"} /> : <ImageIcon size={46} />}</div>{images.length > 1 && <div className="purchase-preview-thumbs">{images.slice(0, 5).map((image, index) => <button type="button" key={image.localId} onClick={() => setPrimaryImage(index)} aria-label={`设为主图 ${index + 1}`}><img src={image.previewUrl} alt="" /></button>)}</div>}<div className="purchase-preview-body"><p className="purchase-preview-category">{form.brand || currentCategory?.name || "品牌 / 类目"}</p><h2>{form.name || "商品名称"}</h2><p className="purchase-preview-description">{form.description || "商品卖点和描述会显示在这里"}</p><div className="purchase-preview-price"><strong>{money(lowPrice)}</strong>{highPrice > lowPrice && <span> - {money(highPrice)}</span>}</div><div className="purchase-preview-specs"><span>选择规格</span><div>{variants.map((variant) => <button type="button" key={variant.localId} className={selectedVariant?.localId === variant.localId ? "active" : ""} onClick={() => setSelectedVariantId(variant.localId)}>{variant.specification || "未命名规格"}</button>)}</div></div><div className="purchase-preview-stock"><span>库存</span><strong>{selectedVariant?.stock === "" ? "待填写" : `${selectedVariant?.stock} 件`}</strong></div><button className="purchase-preview-buy" type="button" disabled>加入采购单</button></div></aside>
    </div>

    <footer className="manual-savebar"><div><strong>{dirty ? "有未保存修改" : success ? "已保存" : editingProduct ? "正在修改退回商品" : "新建草稿"}</strong><span>审核通过后才会同步到订单系统</span></div><div><a className="button button-secondary" href={`${basePath}/catalog`}>取消</a><button className="button button-secondary" type="button" disabled={Boolean(busyMode) || Boolean(success)} onClick={() => void save("draft")}><SaveIcon size={15} />{busyMode === "draft" ? "保存中…" : editingProduct ? "保存修改" : "保存草稿"}</button><button className="button button-primary" type="button" disabled={Boolean(busyMode) || Boolean(success)} onClick={() => void save("review")}><SaveIcon size={15} />{busyMode === "review" ? "保存中…" : editingProduct ? "保存并去审核" : "保存并去审核"}</button></div></footer>
  </>;
}

function Field({ label, required, wide, children }: { label: string; required?: boolean; wide?: boolean; children: ReactNode }) {
  return <label className={`field${wide ? " manual-field-wide" : ""}`}><span>{label}{required && <b aria-hidden="true"> *</b>}</span>{children}</label>;
}

export default function NewCatalogProductPage() {
  return <AppShell active="/catalog"><ManualProductContent /></AppShell>;
}
