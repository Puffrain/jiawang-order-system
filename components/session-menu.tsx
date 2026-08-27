"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";

export function SessionMenu() {
  const pathname = usePathname();
  const [user, setUser] = useState<{ displayName?: string; phone: string; role: "owner" | "buyer" } | null>(null);
  useEffect(() => {
    if (pathname === "/" || pathname.includes("/login") || pathname === "/customer-entry") return;
    fetch("/api/auth/me", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(data => setUser(data?.user ?? null)).catch(() => setUser(null));
  }, [pathname]);
  if (!user) return null;
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign(user.role === "owner" ? "/admin/login" : "/"); };
  return <div className="fixed right-4 top-4 z-[100] flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 py-1.5 pl-3 pr-1.5 text-xs text-slate-600 shadow-lg backdrop-blur print:hidden">
    <span className="max-w-28 truncate">{user.displayName || user.phone}</span><button onClick={logout} className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1.5 font-medium text-slate-700 hover:bg-red-50 hover:text-red-600"><LogOut size={14}/>退出</button>
  </div>;
}
