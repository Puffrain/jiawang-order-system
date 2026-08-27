"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Package, Search, X } from "lucide-react";

export type ProductChoice = { id: string; name: string; brand?: string; status?: string; archived?: boolean; primaryImage?: { url: string } | null; skus?: Array<{ basePrice: number; archivedAt?: string | null }> };

export default function ProductPicker({ onPick, onClose }: { onPick: (product: ProductChoice) => Promise<void> | void; onClose: () => void }) {
  const [products, setProducts] = useState<ProductChoice[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sendingId, setSendingId] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/products", { cache: "no-store" }).then(async (response) => {
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "商品读取失败");
      if (active) setProducts((json.products || []).filter((item: ProductChoice) => item.status === "active" && !item.archived));
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "商品读取失败")).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const filtered = products.filter((product) => `${product.name} ${product.brand || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pick = async (product: ProductChoice) => {
    setSendingId(product.id);
    try { await onPick(product); } finally { setSendingId(""); }
  };

  return (
    <div className="fixed inset-0 z-[170] bg-slate-950/45" role="dialog" aria-modal="true" aria-label="选择推荐商品" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="mobile-scroll ml-auto flex h-full w-full max-w-lg flex-col bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b p-4"><div><h2 className="font-bold">推荐商品</h2><p className="mt-1 text-xs text-slate-400">仅显示当前在售商品</p></div><button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100" aria-label="关闭"><X size={18} /></button></header>
        <label className="relative m-4"><Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-3 text-sm" placeholder="搜索商品或品牌" /></label>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {filtered.map((product) => <button key={product.id} type="button" disabled={Boolean(sendingId)} onClick={() => pick(product)} className="flex w-full items-center gap-3 rounded-xl border p-3 text-left hover:border-orange-300 disabled:opacity-50">{product.primaryImage?.url ? <Image src={product.primaryImage.url} alt="" width={56} height={56} unoptimized className="h-14 w-14 rounded-lg object-cover" /> : <span className="grid h-14 w-14 place-items-center rounded-lg bg-slate-100 text-slate-400"><Package size={20} /></span>}<span className="min-w-0"><b className="block truncate text-sm">{product.name}</b><span className="mt-1 block text-xs text-slate-400">{product.brand || "未设置品牌"}</span></span></button>)}
          {!loading && !filtered.length && <p className="py-12 text-center text-sm text-slate-400">没有可推荐的在售商品</p>}
          {loading && <p className="py-12 text-center text-sm text-slate-400">正在读取商品…</p>}
          {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</p>}
        </div>
      </section>
    </div>
  );
}
