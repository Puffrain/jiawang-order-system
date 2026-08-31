"use client";

import Link from "next/link";
import { ChevronRight, CircleDollarSign } from "lucide-react";
import { useEffect, useState } from "react";

export default function LoyaltyEntry() {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/loyalty", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        const data = json.loyalty ?? json;
        if (active && response.ok) setBalance(Number(data.balancePoints) || 0);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return (
    <Link
      href="/buyer/points"
      className="mobile-action flex min-w-0 items-center gap-3 rounded-2xl bg-white p-4 shadow-sm"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-orange-50 text-orange-600">
        <CircleDollarSign size={23} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-slate-900">我的积分</span>
        <span className="mt-1 block truncate text-xs text-slate-400">
          {balance === null ? "查看积分余额与明细" : `${balance} 积分可用`}
        </span>
      </span>
      <ChevronRight className="shrink-0 text-slate-300" size={18} />
    </Link>
  );
}
