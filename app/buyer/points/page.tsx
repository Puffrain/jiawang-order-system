"use client";

import Link from "next/link";
import { ArrowLeft, CircleDollarSign, Clock3, Gift, ReceiptText, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type LoyaltyEntry = {
  id: string;
  orderId?: string | null;
  orderNo?: string | null;
  eventType: string;
  pointsDelta: number;
  balanceAfter: number;
  amountFen: number;
  createdAt: string;
};

type LoyaltySummary = {
  balancePoints: number;
  earnedPoints: number;
  redeemedPoints: number;
  redeemedFen: number;
  pointValueFen: number;
  earnAmountFen: number;
  entries: LoyaltyEntry[];
};

const eventLabel: Record<string, string> = {
  earn: "订单完成奖励",
  reserve: "下单积分抵扣",
  release: "订单调整退回",
  refund_restore: "订单关闭退回",
};

const yuanFromFen = (fen: number) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;

export default function BuyerPointsPage() {
  const [summary, setSummary] = useState<LoyaltySummary | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/loyalty", { cache: "no-store" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "积分信息读取失败");
      const data = json.loyalty ?? json;
      setSummary({
        balancePoints: Number(data.balancePoints) || 0,
        earnedPoints: Number(data.earnedPoints) || 0,
        redeemedPoints: Number(data.redeemedPoints) || 0,
        redeemedFen: Number(data.redeemedFen) || 0,
        pointValueFen: Number(data.pointValueFen) || 10,
        earnAmountFen: Number(data.earnAmountFen) || 100,
        entries: Array.isArray(data.entries) ? data.entries : [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "积分信息读取失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="mobile-safe-screen bg-slate-100 py-0 sm:py-8">
      <div className="mobile-safe-screen mx-auto w-full max-w-[460px] overflow-hidden bg-[#f7f8fb] shadow-2xl sm:min-h-[860px] sm:rounded-[32px] sm:border-[7px] sm:border-slate-900">
        <header className="safe-top sticky top-0 z-20 flex min-w-0 items-center gap-3 border-b bg-white px-4 py-3">
          <Link aria-label="返回买家中心" href="/buyer" className="mobile-action grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-700">
            <ArrowLeft size={19} />
          </Link>
          <div className="min-w-0">
            <h1 className="font-bold text-slate-900">我的积分</h1>
            <p className="mt-0.5 text-xs text-slate-400">余额、使用记录与奖励明细</p>
          </div>
        </header>

        <div className="space-y-4 p-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
          <section className="rounded-3xl bg-slate-950 p-5 text-white">
            <div className="flex items-center gap-2 text-sm text-orange-300"><CircleDollarSign size={17} />可用积分</div>
            <p className="mt-3 break-words text-4xl font-bold">{summary ? summary.balancePoints : "--"}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 text-sm">
              <div><p className="text-xs text-slate-400">累计获得</p><p className="mt-1 font-semibold">{summary?.earnedPoints ?? "--"} 积分</p></div>
              <div><p className="text-xs text-slate-400">累计抵扣</p><p className="mt-1 font-semibold">{summary ? yuanFromFen(summary.redeemedFen) : "--"}</p></div>
            </div>
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 font-semibold text-slate-900"><Gift className="text-orange-500" size={19} />积分规则</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm">
              <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-700">完成订单</p><p className="mt-1 font-bold text-emerald-800">{summary ? yuanFromFen(summary.earnAmountFen) : "¥1.00"} = 1 积分</p></div>
              <div className="rounded-xl bg-orange-50 p-3"><p className="text-xs text-orange-700">下单抵扣</p><p className="mt-1 font-bold text-orange-800">1 积分 = {summary ? yuanFromFen(summary.pointValueFen) : "¥0.10"}</p></div>
            </div>
            <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 shrink-0 text-slate-400" size={15} />订单完成后积分自动到账；订单调整或关闭时，未使用的积分会自动退回。</p>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="flex items-center gap-2 font-bold"><ReceiptText size={18} />积分明细</h2>{summary&&<span className="text-xs text-slate-400">共 {summary.entries.length} 条</span>}</div>
            {error && <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-600"><p>{error}</p><button onClick={()=>void load()} className="mt-2 font-semibold">重新加载</button></div>}
            {!summary&&!error&&<div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400">正在读取积分…</div>}
            {summary&&summary.entries.length===0&&<div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-400"><Clock3 className="mx-auto mb-2"/>暂无积分明细</div>}
            <div className="space-y-2">
              {summary?.entries.map(entry=><article key={entry.id} className="flex min-w-0 items-center gap-3 rounded-2xl bg-white p-4 shadow-sm"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${entry.pointsDelta>=0?"bg-emerald-50 text-emerald-600":"bg-orange-50 text-orange-600"}`}><CircleDollarSign size={20}/></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{eventLabel[entry.eventType]||"积分变动"}</p><p className="mt-1 truncate text-xs text-slate-400">{entry.orderNo?`订单 ${entry.orderNo} · `:""}{new Date(entry.createdAt).toLocaleString("zh-CN")}</p></div><div className="shrink-0 text-right"><p className={`font-bold ${entry.pointsDelta>=0?"text-emerald-600":"text-orange-600"}`}>{entry.pointsDelta>0?"+":""}{entry.pointsDelta}</p><p className="mt-1 text-[11px] text-slate-400">余额 {entry.balanceAfter}</p></div></article>)}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
