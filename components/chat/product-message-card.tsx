"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRight, Package } from "lucide-react";

export type RecommendedProduct = {
  id: string;
  name?: string;
  brand?: string;
  imageUrl?: string | null;
  price?: number | null;
  status?: "active" | "inactive";
};

const money = (value: number) => `¥${Number(value).toFixed(2)}`;

export default function ProductMessageCard({ product }: { product: RecommendedProduct }) {
  const [available, setAvailable] = useState(product.status !== "inactive");
  useEffect(() => {
    let active = true;
    void fetch(`/api/products/${encodeURIComponent(product.id)}`, { cache: "no-store" }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (active) setAvailable(response.ok && data.product?.status === "active" && !data.product?.archived);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [product.id]);
  return (
    <Link href={`/buyer/products/${encodeURIComponent(product.id)}`} className="group mt-1 flex min-w-0 items-center gap-3 rounded-xl border border-orange-100 bg-white p-3 text-slate-900 shadow-sm transition hover:border-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
      {product.imageUrl ? (
        <Image src={product.imageUrl} alt="" width={64} height={64} unoptimized className="h-16 w-16 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-orange-50 text-orange-500"><Package size={22} /></span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block text-[11px] font-semibold ${available ? "text-orange-600" : "text-slate-400"}`}>{available ? "商家推荐 · 在售" : "商家推荐 · 已下架"}</span>
        <b className="mt-1 block truncate text-sm">{product.name || "查看商品详情"}</b>
        <span className="mt-1 block text-xs text-slate-500">{product.price != null ? `起价 ${money(product.price)}` : product.brand || "点击查看规格与价格"}</span>
      </span>
      <ChevronRight size={17} className="shrink-0 text-orange-500 transition group-hover:translate-x-0.5" />
    </Link>
  );
}
