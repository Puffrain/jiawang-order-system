"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";

export default function AdminDebugBuyerButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enter = async () => {
    if (!window.confirm("将切换为调试买家账号，返回后台时需要重新登录老板账号。确定继续吗？")) return;
    setBusy(true); setError("");
    const response = await fetch("/api/auth/buyer/debug-login", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setBusy(false); setError(body.error || "暂时无法进入调试模式"); return; }
    window.location.assign("/buyer");
  };
  return <div className="fixed bottom-5 right-5 z-[100] flex flex-col items-end gap-2 print:hidden">
    {error && <button onClick={() => setError("")} className="max-w-xs rounded-xl bg-red-50 px-4 py-3 text-left text-xs text-red-700 shadow-lg">{error}</button>}
    <button disabled={busy} onClick={enter} className="flex items-center gap-2 rounded-full bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-violet-700 disabled:opacity-60"><FlaskConical size={17}/>{busy ? "正在切换…" : "买家调试入口"}</button>
  </div>;
}
