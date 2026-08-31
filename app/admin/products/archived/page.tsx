"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, ChevronLeft, Eye, LoaderCircle, RefreshCw, RotateCcw, Search, Trash2, XCircle } from "lucide-react";

type Product = {
  id: string;
  name: string;
  category: string;
  brand?: string;
  archived: boolean;
  permanentlyHidden?: boolean;
  primaryImage: { url: string } | null;
  skus: Array<{ skuCode: string }>;
  totalStock: number;
};
type Operation = "restore" | "hide";
type Result = { id: string; name: string; operation: Operation; status: "pending" | "success" | "error"; message: string };
type ApiResult = { id?: string; productId?: string; ok?: boolean; success?: boolean; status?: string; action?: string; reason?: string; error?: string; message?: string };

const operationLabel = (operation: Operation) => operation === "restore" ? "恢复" : "彻底隐藏";

function normalizeResult(product: Product, operation: Operation, raw: ApiResult | undefined, responseOk: boolean, fallback: string): Result {
  const succeeded = responseOk && Boolean(raw && (raw.ok === true || raw.success === true || raw.status === "success"));
  return { id: product.id, name: product.name, operation, status: succeeded ? "success" : "error", message: raw?.reason || raw?.message || raw?.error || fallback };
}

export default function ArchivedProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<Operation | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/products/archived", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "归档商品读取失败");
      const archived: Product[] = (Array.isArray(body.products) ? body.products : []).filter((product: Product) => product.archived && !product.permanentlyHidden);
      setProducts(archived);
      setSelected((current) => new Set([...current].filter((id) => archived.some((product) => product.id === id))));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档商品读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return products;
    return products.filter((product) => [product.name, product.brand || "", product.category, ...product.skus.map((sku) => sku.skuCode)].join(" ").toLowerCase().includes(keyword));
  }, [products, query]);
  const filteredIds = filtered.map((product) => product.id);
  const allVisibleSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const selectedProducts = products.filter((product) => selected.has(product.id));

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    if (allVisibleSelected) filteredIds.forEach((id) => next.delete(id));
    else filteredIds.forEach((id) => next.add(id));
    return next;
  });

  const runBatch = async (items: Product[], operation: Operation) => {
    if (!items.length || processing) return;
    const confirmation = operation === "restore"
      ? "确定恢复选中的 " + items.length + " 个归档商品吗？恢复结果会逐项显示。"
      : "确定彻底隐藏选中的 " + items.length + " 个归档商品吗？隐藏后将不再在归档列表显示。";
    if (!window.confirm(confirmation)) return;

    setProcessing(operation);
    setError("");
    setResults(items.map((item) => ({ id: item.id, name: item.name, operation, status: "pending", message: "正在处理" })));
    try {
      const response = operation === "restore"
        ? await fetch("/api/admin/products/bulk-restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productIds: items.map((item) => item.id) }),
          })
        : await fetch("/api/admin/products/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: items.map((item) => item.id), action: "auto" }),
      });
      const body = await response.json().catch(() => ({}));
      const rawResults = Array.isArray(body.results) ? body.results as ApiResult[] : [];
      const byId = new Map(rawResults.map((result) => [String(result.productId || result.id || ""), result]));
      const unavailable = operation === "restore" && [404, 405, 501].includes(response.status);
      const fallback = unavailable
        ? "恢复接口暂未可用，商品未被修改"
        : response.ok
          ? "接口未返回逐项结果，无法确认商品状态"
          : body.error || operationLabel(operation) + "失败（" + response.status + "）";
      const nextResults = items.map((item) => normalizeResult(item, operation, byId.get(item.id), response.ok, fallback));
      setResults(nextResults);
      const completedIds = new Set(nextResults.filter((result) => result.status === "success").map((result) => result.id));
      setSelected((current) => new Set([...current].filter((id) => !completedIds.has(id))));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : operationLabel(operation) + "失败，请稍后重试";
      setResults(items.map((item) => ({ id: item.id, name: item.name, operation, status: "error", message })));
    } finally {
      setProcessing(null);
      await load();
    }
  };

  const isProcessing = processing !== null;
  return <main className="min-h-screen bg-slate-100 text-slate-900">
    <header className="bg-slate-950 text-white"><div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6"><Link href="/admin?tab=products" aria-label="返回商品管理" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10 hover:bg-white/20"><ChevronLeft size={20} /></Link><div className="min-w-0"><h1 className="truncate text-lg font-bold">归档商品</h1><p className="mt-0.5 text-xs text-slate-400">集中查看、恢复或彻底隐藏已退出在线销售的商品</p></div></div></header>
    <div className="mx-auto max-w-6xl p-3 sm:p-6"><section className="rounded-2xl bg-white p-3 shadow-sm sm:rounded-3xl sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h2 className="font-bold">已归档 {products.length} 个</h2><p className="mt-1 text-xs leading-5 text-slate-500">批量操作只提交一次请求；服务端会为每个商品返回独立结果。</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void load()} disabled={loading || isProcessing} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 disabled:opacity-50" title="刷新" aria-label="刷新归档商品"><RefreshCw size={17} className={loading ? "animate-spin" : ""} /></button><button type="button" onClick={() => void runBatch(selectedProducts, "restore")} disabled={!selectedProducts.length || isProcessing} className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300 sm:flex-none"><RotateCcw size={17} /><span className="truncate">恢复选中{selectedProducts.length ? "（" + selectedProducts.length + "）" : ""}</span></button><button type="button" onClick={() => void runBatch(selectedProducts, "hide")} disabled={!selectedProducts.length || isProcessing} className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300 sm:flex-none"><Trash2 size={17} /><span className="truncate">彻底隐藏{selectedProducts.length ? "（" + selectedProducts.length + "）" : ""}</span></button></div></div>
      <label className="relative mt-4 block"><Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-3 text-sm outline-none focus:border-orange-500" placeholder="搜索商品、品牌、分类或 SKU" /></label>
      {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700"><AlertTriangle size={17} className="mt-0.5 shrink-0" /><span className="min-w-0 break-words">{error}</span></p>}
      <div className="mt-4 flex min-h-11 items-center justify-between gap-3 rounded-xl bg-slate-50 px-3"><label className="flex min-w-0 cursor-pointer items-center gap-3 text-sm font-medium"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} disabled={!filteredIds.length || isProcessing} className="h-4 w-4 accent-orange-500" /><span className="truncate">选择当前结果</span></label><span className="shrink-0 text-xs text-slate-400">{filtered.length} 个结果</span></div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">{filtered.map((product) => <article key={product.id} className={"flex min-w-0 gap-3 rounded-2xl border p-3 " + (selected.has(product.id) ? "border-orange-400 bg-orange-50/40" : "border-slate-200")}><label className="flex shrink-0 cursor-pointer items-start pt-1"><input type="checkbox" checked={selected.has(product.id)} onChange={() => toggle(product.id)} disabled={isProcessing} className="h-4 w-4 accent-orange-500" /><span className="sr-only">选择{product.name}</span></label>{product.primaryImage ? <Image src={product.primaryImage.url} alt="" width={64} height={64} unoptimized className="h-16 w-16 shrink-0 rounded-xl object-cover" /> : <div className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-400"><Archive size={20} /></div>}<div className="min-w-0 flex-1"><Link href={"/buyer/products/" + product.id + "?from=archived"} className="line-clamp-2 text-sm font-bold hover:text-orange-600">{product.name}</Link><p className="mt-1 truncate text-xs text-slate-400">{product.brand || "未设置品牌"} · {product.category}</p><p className="mt-2 break-words text-xs text-slate-500">{product.skus.length} 个规格 · 库存记录 {product.totalStock}</p></div><div className="flex shrink-0 flex-col gap-1"><Link href={"/buyer/products/" + product.id + "?from=archived"} className="grid h-10 w-10 place-items-center rounded-lg bg-sky-50 text-sky-700" title="预览商品" aria-label={"预览" + product.name}><Eye size={16} /></Link><button type="button" onClick={() => void runBatch([product], "restore")} disabled={isProcessing} className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-50 text-emerald-700 disabled:opacity-50" title="恢复商品" aria-label={"恢复" + product.name}><RotateCcw size={16} /></button><button type="button" onClick={() => void runBatch([product], "hide")} disabled={isProcessing} className="grid h-10 w-10 place-items-center rounded-lg bg-red-50 text-red-600 disabled:opacity-50" title="彻底隐藏" aria-label={"彻底隐藏" + product.name}><Trash2 size={16} /></button></div></article>)}</div>
      {!filtered.length && !loading && <div className="py-14 text-center text-sm text-slate-400"><Archive className="mx-auto mb-3" />{products.length ? "没有符合搜索条件的归档商品" : "暂无归档商品"}</div>}
    </section>
    {results.length > 0 && <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm sm:rounded-3xl sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-bold">逐项处理结果</h2><button type="button" onClick={() => setResults([])} disabled={isProcessing} className="text-xs text-slate-500 disabled:opacity-50">清空结果</button></div><div className="mt-3 space-y-2">{results.map((result) => <div key={result.operation + result.id} className="flex min-w-0 items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm">{result.status === "pending" ? <LoaderCircle size={17} className="mt-0.5 shrink-0 animate-spin text-slate-400" /> : result.status === "success" ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={17} className="mt-0.5 shrink-0 text-red-600" />}<div className="min-w-0"><p className="break-words font-semibold">{operationLabel(result.operation)} · {result.name}</p><p className={"mt-1 break-words text-xs " + (result.status === "error" ? "text-red-600" : "text-slate-500")}>{result.message}</p></div></div>)}</div></section>}
    </div>
  </main>;
}
