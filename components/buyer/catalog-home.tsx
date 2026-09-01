"use client";

import Image from "next/image";
import Link from "next/link";
import { Bell, ChevronDown, Search, ShoppingCart, Store } from "lucide-react";
import { useMemo, useState } from "react";
import { NoticeContent } from "@/components/admin/notice-editor";

type Sku = { id: string; skuCode: string; specName: string; basePrice: number; stock: number; tiers: { minQty: number; maxQty: number | null; unitPrice: number }[] };
type Product = { id: string; name: string; category: string; categoryKey?: string; subcategoryKey?: string | null; brand?: string; description?: string; primaryImage: { url: string } | null; salesCount: number; skus: Sku[] };
type CustomerNotice = { id: string; title: string; document: { blocks: Array<{ type: "heading" | "paragraph" | "list" | "image"; text?: string; items?: string[]; align?: "left" | "center" | "right"; marks?: { bold?: boolean; italic?: boolean; underline?: boolean; fontSize?: number; color?: string; link?: string }; src?: string; alt?: string }> } };

const money = (value: number) => "¥" + Number(value).toFixed(2).replace(/[.]00$/, "");

export default function CatalogHome({ products, notices, onAdded }: { products: Product[]; notices: CustomerNotice[]; onAdded: () => Promise<void> | void }) {
  const [query, setQuery] = useState("");
  const [primary, setPrimary] = useState("all");
  const [secondary, setSecondary] = useState("all");
  const [sort, setSort] = useState<"recommend" | "sales" | "price">("recommend");
  const [adding, setAdding] = useState("");
  const primaryItems = useMemo(() => [
    { key: "all", label: "全部商品", image: products.find((item) => item.primaryImage)?.primaryImage?.url || "" },
    ...[...new Map(products.map((product) => [product.categoryKey || product.category, { key: product.categoryKey || product.category, label: product.category, image: product.primaryImage?.url || "" }])).values()],
  ], [products]);
  const secondaryItems = useMemo(() => ["all", ...[...new Set(products.filter((product) => primary === "all" || (product.categoryKey || product.category) === primary).map((product) => product.subcategoryKey || product.category).filter(Boolean))]], [products, primary]);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    const list = products.filter((product) => (!value || (product.name + " " + (product.brand || "") + " " + product.skus.map((sku) => sku.skuCode).join(" ")).toLowerCase().includes(value)) && (primary === "all" || (product.categoryKey || product.category) === primary) && (secondary === "all" || (product.subcategoryKey || product.category) === secondary));
    if (sort === "price") return [...list].sort((a, b) => lowest(a) - lowest(b));
    if (sort === "sales") return [...list].sort((a, b) => b.salesCount - a.salesCount || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
    return list;
  }, [products, query, primary, secondary, sort]);
  const add = async (product: Product) => {
    const sku = product.skus.find((item) => item.stock > 0);
    if (!sku) return;
    setAdding(product.id);
    try {
      const response = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skuId: sku.id, quantity: 1 }) });
      if (response.ok) await onAdded();
    } finally { setAdding(""); }
  };

  return <div data-buyer-catalog className="bg-white lg:mx-auto lg:max-w-[1320px] lg:px-8 lg:pb-10">
    <div className="sticky top-0 z-20 bg-white px-3 pb-2 pt-3 lg:static lg:px-0 lg:pt-7">
      <label className="flex h-12 items-center gap-2 rounded-xl border-2 border-orange-400 bg-white px-3 lg:mx-auto lg:max-w-3xl">
        <Search size={21} className="text-slate-400" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、品牌或 SKU" className="min-w-0 flex-1 bg-transparent text-base outline-none" />
      </label>
      <div data-buyer-primary-categories className="mt-3 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] justify-start lg:gap-6">
        {primaryItems.map((item) => <button key={item.key} onClick={() => { setPrimary(item.key); setSecondary("all"); }} className="w-[66px] shrink-0 text-center lg:w-[82px]">
          <span className={"mx-auto grid h-14 w-14 overflow-hidden rounded-xl border-2 bg-orange-50 lg:h-16 lg:w-16 " + (primary === item.key ? "border-orange-500" : "border-transparent")}>
            {item.image ? <Image src={item.image} alt="" width={64} height={64} unoptimized className="h-full w-full object-cover" /> : <Store className="m-auto text-orange-300" />}
          </span>
          <span className={"mt-1 block truncate rounded-md px-1 py-0.5 text-xs " + (primary === item.key ? "bg-orange-500 text-white" : "text-slate-600")}>{item.label}</span>
        </button>)}
      </div>
    </div>
    {notices[0] && <details className="mx-3 mb-2 rounded-xl bg-orange-50 px-3 py-2 text-sm lg:mx-0 lg:mb-5"><summary className="flex cursor-pointer list-none items-center gap-2 font-semibold text-orange-700"><Bell size={15} />{notices[0].title}<ChevronDown size={14} className="ml-auto" /></summary><div className="mt-2 border-t border-orange-100 pt-2"><NoticeContent notice={notices[0]} /></div></details>}
    <div className="sticky top-[154px] z-10 grid grid-cols-3 border-y bg-white text-sm lg:static lg:mx-auto lg:max-w-3xl lg:rounded-lg lg:border">
      <button onClick={() => setSort("recommend")} className={"py-3 " + (sort === "recommend" ? "font-bold text-orange-600" : "text-slate-500")}>为您推荐</button>
      <button onClick={() => setSort("sales")} className={"py-3 " + (sort === "sales" ? "font-bold text-orange-600" : "text-slate-500")}>销量优先</button>
      <button onClick={() => setSort("price")} className={"py-3 " + (sort === "price" ? "font-bold text-orange-600" : "text-slate-500")}>价格 ↑</button>
    </div>
    <div className="grid h-[calc(100dvh-15.75rem)] min-h-[320px] grid-cols-[92px_1fr] lg:mt-6 lg:h-[calc(100vh-17rem)] lg:grid-cols-[184px_minmax(0,1fr)] lg:gap-6">
      <aside data-buyer-catalog-sidebar className="overflow-y-auto bg-slate-50 lg:rounded-lg lg:border lg:bg-white lg:py-2">
        {secondaryItems.map((item) => <button key={item} onClick={() => setSecondary(item)} className={"relative block min-h-14 w-full px-2 py-4 text-sm lg:text-left " + (secondary === item ? "bg-white font-bold text-slate-900 before:absolute before:inset-y-3 before:left-0 before:w-1 before:rounded-r before:bg-orange-500 lg:bg-orange-50" : "text-slate-600")}>{item === "all" ? "全部" : item}</button>)}
      </aside>
      <section data-buyer-product-list className="min-w-0 overflow-y-auto bg-white lg:grid lg:grid-cols-2 lg:gap-5 xl:grid-cols-3">
        {filtered.map((product) => <ProductRow key={product.id} product={product} adding={adding === product.id} add={() => void add(product)} />)}
        {!filtered.length && <div className="grid h-64 place-items-center px-5 text-sm text-slate-400 lg:col-span-full">没有符合条件的商品</div>}
      </section>
    </div>
  </div>;
}

function lowest(product: Product) { const values = product.skus.flatMap((sku) => [sku.basePrice, ...sku.tiers.map((tier) => tier.unitPrice)]); return values.length ? Math.min(...values) : 0; }
function stock(product: Product) { return product.skus.reduce((sum, sku) => sum + sku.stock, 0); }

function ProductRow({ product, adding, add }: { product: Product; adding: boolean; add: () => void }) {
  const quantity = stock(product);
  const price = lowest(product);
  const sku = product.skus.find((item) => item.stock > 0);
  return <article data-buyer-product-card className="flex min-h-36 gap-3 border-b p-3 lg:min-h-0 lg:flex-col lg:overflow-hidden lg:rounded-lg lg:border lg:p-0 lg:shadow-sm">
    <Link href={"/buyer/products/" + product.id} className="relative h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-slate-100 lg:h-auto lg:w-full lg:rounded-none lg:aspect-[4/3]">
      {product.primaryImage ? <Image src={product.primaryImage.url} alt={product.name} fill unoptimized className="object-contain" /> : <Store className="absolute inset-0 m-auto text-slate-300" />}
    </Link>
    <div className="min-w-0 flex-1 lg:flex lg:min-h-[160px] lg:flex-col lg:px-4 lg:pb-4">
      <Link href={"/buyer/products/" + product.id}><h3 className="line-clamp-2 font-medium leading-6 text-slate-900">{product.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{product.description || product.brand || product.category}</p></Link>
      <p className="mt-1 text-xs text-orange-600">库存 {quantity} 件</p>
      <div className="mt-1 flex items-end justify-between gap-2 lg:mt-auto"><strong className="text-xl text-red-600">{money(price)}</strong><button type="button" onClick={add} disabled={!sku || adding} aria-label={"将" + product.name + "加入购物车"} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange-500 text-white shadow-sm disabled:bg-slate-300"><ShoppingCart size={19} /></button></div>
    </div>
  </article>;
}
