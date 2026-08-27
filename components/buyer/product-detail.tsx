"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronLeft, Minus, Package, Plus, ShoppingCart, Store } from "lucide-react";
import FormattedDescription from "@/components/buyer/formatted-description";

type Tier = { minQty: number; maxQty: number | null; unitPrice: number };
type Sku = { id: string; specName: string; basePrice: number; stock: number; tiers: Tier[] };
type Product = { id: string; name: string; category: string; brand?: string; description?: string; status?: "active" | "inactive"; archived?: boolean; permanentlyHidden?: boolean; primaryImage: { url: string } | null; images: { id: string; url: string }[]; skus: Sku[]; recommendations?: Product[]; relatedProducts?: Product[] };
const money = (value: number) => `¥${Number(value).toFixed(2)}`;

export default function ProductDetail({ productId }: { productId: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [role, setRole] = useState<"owner" | "buyer" | null>(null);
  const [selected, setSelected] = useState("");
  const [image, setImage] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [missing, setMissing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [back, setBack] = useState({ href: "/buyer", label: "返回首页" });

  useEffect(() => {
    let active = true;
    let loadedProduct = false;
    let refreshing = false;
    const source = new URLSearchParams(window.location.search).get("from");
    if (source === "admin") setBack({ href: "/admin?tab=products", label: "返回商品管理" });
    if (source === "archived") setBack({ href: "/admin/products/archived", label: "返回归档商品" });

    const refresh = async (currentRole: "owner" | "buyer") => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch(`/api/products/${productId}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        if (response.status === 404) {
          if (currentRole === "buyer" && loadedProduct) {
            setUnavailable(true);
            setMessage("商品已下架，暂时无法购买");
          } else {
            setMissing(true);
          }
          return;
        }
        if (!response.ok) throw new Error(body.error || "商品详情读取失败");
        const nextProduct = body.product as Product;
        loadedProduct = true;
        setProduct(nextProduct);
        setUnavailable(currentRole === "buyer" && (nextProduct.status !== "active" || Boolean(nextProduct.archived) || Boolean(nextProduct.permanentlyHidden)));
        setMissing(false);
        setError("");
        setSelected((current) => nextProduct.skus.some((item) => item.id === current) ? current : nextProduct.skus[0]?.id || "");
        setImage((current) => nextProduct.images.some((item) => item.url === current) ? current : nextProduct.primaryImage?.url || nextProduct.images[0]?.url || "");
      } catch (reason) {
        if (active && !loadedProduct) setError(reason instanceof Error ? reason.message : "商品详情读取失败，请稍后重试");
      } finally {
        refreshing = false;
      }
    };

    let interval: ReturnType<typeof setInterval> | undefined;
    let onFocus: (() => void) | undefined;
    let onVisibilityChange: (() => void) | undefined;
    void fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!active) return;
      if (!response.ok || !["owner", "buyer"].includes(body.user?.role)) throw new Error(body.error || "账号身份读取失败");
      const currentRole = body.user.role as "owner" | "buyer";
      setRole(currentRole);
      await refresh(currentRole);
      if (!active) return;
      onFocus = () => { void refresh(currentRole); };
      onVisibilityChange = () => { if (document.visibilityState === "visible") void refresh(currentRole); };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibilityChange);
      interval = setInterval(() => { void refresh(currentRole); }, 15_000);
    }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "商品详情读取失败，请稍后重试"));
    return () => {
      active = false;
      if (interval) clearInterval(interval);
      if (onFocus) window.removeEventListener("focus", onFocus);
      if (onVisibilityChange) document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [productId]);

  if (missing) return <StatePage title="商品不存在或已不可查看" message="商品可能已被删除，或当前账号无权访问。" back={back} />;
  if (error) return <StatePage title="商品详情读取失败" message={error} back={back} error />;
  if (!product || !role) return <main className="grid min-h-screen place-items-center bg-slate-100 text-slate-400">正在读取商品…</main>;

  const merchantPreview = role === "owner";
  const purchasable = !merchantPreview && !unavailable && product.status === "active" && !product.archived && !product.permanentlyHidden;
  const recommendations = (product.recommendations || []).slice(0, 6);
  const related = (product.relatedProducts || []).slice(0, 8);
  const sku = product.skus.find((item) => item.id === selected) || product.skus[0];
  const unitPrice = sku ? [...sku.tiers].sort((a, b) => b.minQty - a.minQty).find((tier) => quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty))?.unitPrice ?? sku.basePrice : 0;
  const add = async () => {
    if (!sku || !purchasable) return;
    setBusy(true); setMessage("");
    try {
      const currentResponse = await fetch("/api/cart", { cache: "no-store" });
      const currentBody = await currentResponse.json().catch(() => ({}));
      if (!currentResponse.ok) throw new Error(currentBody.error || "购物车读取失败");
      const existing = (currentBody.items || []).find((item: { skuId: string; quantity: number }) => item.skuId === sku.id);
      const response = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skuId: sku.id, quantity: (existing?.quantity || 0) + quantity }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "加入购物车失败");
      setMessage("已加入购物车");
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "加入购物车失败，请稍后重试"); }
    finally { setBusy(false); }
  };

  return <main className={`min-h-screen bg-[#f4f5f7] ${merchantPreview ? "pb-8" : "pb-28"}`}><div className="mx-auto min-h-screen max-w-[520px] overflow-hidden bg-white">
    <header className="sticky top-0 z-20 flex min-w-0 items-center gap-3 border-b bg-white/95 px-4 py-3 backdrop-blur"><Link href={back.href} aria-label={back.label} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100"><ChevronLeft /></Link><b className="min-w-0 flex-1 truncate">{merchantPreview ? "商品预览" : "商品详情"}</b>{merchantPreview && <span className="shrink-0 rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">购买控件已隐藏</span>}</header>
    <section className="relative aspect-square bg-slate-100">{image ? <Image src={image} alt={product.name} fill priority unoptimized className="object-contain" /> : <div className="grid h-full place-items-center bg-orange-50"><Store size={56} className="text-orange-200" /></div>}</section>
    {product.images.length > 1 && <div className="flex gap-2 overflow-x-auto px-4 py-3">{product.images.map((item) => <button key={item.id} onClick={() => setImage(item.url)} className={`shrink-0 overflow-hidden rounded-lg border-2 bg-slate-100 ${image === item.url ? "border-orange-500" : "border-transparent"}`}><Image src={item.url} alt="商品缩略图" width={64} height={64} unoptimized className="h-16 w-16 object-contain" /></button>)}</div>}
    <section className="border-t p-5"><p className="text-2xl font-bold text-rose-600">{money(unitPrice)}</p><h1 className="mt-3 break-words text-xl font-bold leading-7">{product.name}</h1><p className="mt-2 break-words text-sm text-slate-500">{product.brand || product.category}</p>{merchantPreview && <p className="mt-3 rounded-xl bg-slate-100 p-3 text-sm text-slate-600">当前状态：{product.archived ? "已归档" : product.status === "active" ? "已上架" : "已下架"}</p>}{!merchantPreview && unavailable && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">商品已下架，暂时无法购买</p>}</section>
    <section className="border-t p-5"><h2 className="font-bold">选择规格</h2><div className="mt-3 flex flex-wrap gap-2">{product.skus.map((item) => <button key={item.id} disabled={!merchantPreview && !purchasable} onClick={() => { setSelected(item.id); setQuantity(1); }} className={`max-w-full break-words rounded-xl border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${sku?.id === item.id ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-200"}`}>{item.specName}</button>)}</div>{sku && <><div className="mt-5 flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 text-sm text-slate-500">库存 {sku.stock}</span>{!merchantPreview && <div className="flex shrink-0 items-center gap-3"><button disabled={!purchasable} onClick={() => setQuantity(Math.max(1, quantity - 1))} className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 disabled:opacity-50"><Minus size={15} /></button><b>{quantity}</b><button disabled={!purchasable} onClick={() => setQuantity(Math.min(sku.stock, quantity + 1))} className="grid h-9 w-9 place-items-center rounded-lg bg-orange-500 text-white disabled:bg-slate-300"><Plus size={15} /></button></div>}</div>{sku.tiers.length > 0 && <div className="mt-4 rounded-xl bg-orange-50 p-3 text-sm"><b>批发阶梯价</b>{sku.tiers.map((tier) => <p key={tier.minQty} className="mt-2 flex min-w-0 justify-between gap-3 text-slate-600"><span className="min-w-0">{tier.minQty}{tier.maxQty ? `-${tier.maxQty} 件` : " 件以上"}</span><b className="shrink-0">{money(tier.unitPrice)}/件</b></p>)}</div>}</>}</section>
    {product.description && <section className="border-t p-5"><h2 className="font-bold">商品说明</h2><FormattedDescription text={product.description} className="mt-3 break-words text-sm leading-6 text-slate-600" /></section>}
    {!merchantPreview && <><ProductGroup title="为你推荐" products={recommendations} /><ProductGroup title="相关商品" products={related} /></>}
  </div>{!merchantPreview && <div className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-[520px] min-w-0 items-center gap-3 overflow-hidden border-t bg-white p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">{message && <span className={`min-w-0 flex-1 truncate text-xs ${message === "已加入购物车" ? "text-emerald-600" : "text-red-600"}`}>{message}</span>}<button onClick={add} disabled={busy||!sku||sku.stock<1||!purchasable} className="ml-auto flex min-w-0 max-w-full shrink items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-3 font-semibold text-white disabled:bg-slate-300"><ShoppingCart size={18} className="shrink-0" /><span className="truncate">{!purchasable ? "已下架" : sku?.stock ? busy ? "加入中…" : "加入购物车" : "暂时缺货"}</span></button></div>}</main>;
}

function StatePage({ title, message, back, error = false }: { title: string; message: string; back: { href: string; label: string }; error?: boolean }) {
  return <main className="min-h-screen bg-slate-100 p-4"><div className="mx-auto max-w-[520px] rounded-2xl bg-white p-8 text-center"><Package className="mx-auto text-slate-300" size={42} /><h1 className="mt-4 text-xl font-bold">{title}</h1><p className={`mt-2 break-words text-sm ${error ? "text-red-600" : "text-slate-500"}`}>{message}</p><Link href={back.href} className="mt-6 inline-flex rounded-xl bg-orange-500 px-5 py-3 font-semibold text-white">{back.label}</Link></div></main>;
}

function ProductGroup({ title, products }: { title: string; products: Product[] }) {
  if (!products.length) return null;
  return <section className="border-t p-5"><h2 className="font-bold">{title}</h2><div className="mt-3 grid grid-cols-2 gap-3">{products.map((product) => <Link key={product.id} href={`/buyer/products/${product.id}`} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="relative aspect-square bg-slate-100">{product.primaryImage ? <Image src={product.primaryImage.url} alt={product.name} fill unoptimized className="object-contain" /> : <div className="grid h-full place-items-center bg-orange-50"><Store className="text-orange-200" /></div>}</div><div className="p-3"><p className="line-clamp-2 break-words text-sm font-semibold">{product.name}</p><p className="mt-1 truncate text-xs text-slate-400">{product.brand || product.category}</p></div></Link>)}</div></section>;
}
