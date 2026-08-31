"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Role } from "../lib/contracts/platform";
import { apiErrorMessage, apiFetch, apiJson, ApiClientError } from "./api-client";
import { CatalogIcon, CloseIcon, HomeIcon, LogoutIcon, MenuIcon, ReviewIcon, SettingsIcon, UploadIcon } from "./icon";
import { ErrorState, LoadingBlock, RoleBadge } from "./ui";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  isActive?: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

interface SessionContextValue {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 AppShell 内使用");
  return value;
}

function normalizeUser(value: unknown): SessionUser | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = (record.user && typeof record.user === "object" ? record.user : record) as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.username !== "string") return null;
  const role = candidate.role;
  if (role !== "admin" && role !== "reviewer" && role !== "viewer") return null;
  return {
    id: candidate.id,
    username: candidate.username,
    role,
    isActive: candidate.isActive === undefined ? true : Boolean(candidate.isActive),
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
    lastLoginAt: typeof candidate.lastLoginAt === "string" ? candidate.lastLoginAt : null,
  };
}

type NavItem = { href: string; label: string; hint: string; icon: typeof HomeIcon; minimumRole: Role };

const navItems: NavItem[] = [
  { href: "/dashboard", label: "工作台", hint: "任务与资源概览", icon: HomeIcon, minimumRole: "viewer" },
  { href: "/imports", label: "导入任务", hint: "ZIP 分块上传", icon: UploadIcon, minimumRole: "reviewer" },
  { href: "/review", label: "人工审核", hint: "确认 AI 建议", icon: ReviewIcon, minimumRole: "reviewer" },
  { href: "/catalog", label: "商品库", hint: "已发布商品", icon: CatalogIcon, minimumRole: "viewer" },
  { href: "/settings", label: "系统设置", hint: "账号与备份", icon: SettingsIcon, minimumRole: "admin" },
];

const level: Record<Role, number> = { viewer: 10, reviewer: 20, admin: 30 };
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";

function hasRole(actual: Role, required: Role) {
  return level[actual] >= level[required];
}

export function AppShell({ children, active }: { children: ReactNode; active?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiFetch<unknown>("/api/v1/auth/me", { cache: "no-store" });
      const nextUser = normalizeUser(payload);
      if (!nextUser) throw new Error("服务端返回的会话信息无效");
      setUser(nextUser);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 401) {
        setUser(null);
        setError("请先登录后再访问管理界面");
      } else {
        setError(apiErrorMessage(cause));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!loading && !user && pathname !== "/login") {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/login?next=${next}`);
    }
  }, [loading, user, pathname, router]);

  const logout = useCallback(async () => {
    try { await apiJson("/api/v1/auth/logout", "POST"); } catch { /* session is cleared locally below */ }
    setUser(null);
    router.replace("/login");
  }, [router]);

  const visibleNav = useMemo(
    () => (user ? navItems.filter((item) => hasRole(user.role, item.minimumRole)) : []),
    [user],
  );

  const context = useMemo<SessionContextValue>(() => ({ user, loading, error, refresh, logout }), [user, loading, error, refresh, logout]);
  const keepWarehouseBasePath = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target === "_blank") return;
    const href = anchor.getAttribute("href");
    if (!href?.startsWith("/") || href.startsWith("//") || href === basePath || href.startsWith(`${basePath}/`)) return;
    event.preventDefault();
    window.location.assign(`${basePath}${href}`);
  };

  if (loading) {
    return <SessionContext.Provider value={context}><main className="auth-loading"><LoadingBlock label="正在验证会话…" /></main></SessionContext.Provider>;
  }

  if (!user) {
    return <SessionContext.Provider value={context}><main className="auth-loading"><ErrorState message={error || "未找到有效会话"} onRetry={() => void refresh()} /><a className="button button-primary" href={`${basePath}/login`}>返回登录</a></main></SessionContext.Provider>;
  }

  return (
    <SessionContext.Provider value={context}>
      <div className="app-shell" onClick={keepWarehouseBasePath}>
        {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" type="button" onClick={() => setMobileOpen(false)} />}
        <aside className={`sidebar${mobileOpen ? " sidebar-open" : ""}`} aria-label="主导航">
          <div className="brand-lockup"><img className="brand-mark" src={`${basePath}/brand/portrait.jpg`} alt="佳旺商品库" /><div><strong>佳旺商品库</strong><span>同城美发店 · 专属批发平台 · 免费送货上门 · 下单即享优惠</span></div><button className="icon-button sidebar-close" type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><CloseIcon size={19} /></button></div>
          <div className="workspace-label">工作区 · 单租户</div>
          <nav className="primary-nav">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              const selected = active ? active === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return <a key={item.href} href={`${basePath}${item.href}`} className={`nav-link${selected ? " nav-link-active" : ""}`} aria-current={selected ? "page" : undefined} onClick={() => setMobileOpen(false)}><Icon size={19} /><span><strong>{item.label}</strong><small>{item.hint}</small></span></a>;
            })}
          </nav>
          <div className="sidebar-spacer" />
          {user.role === "viewer" && <div className="readonly-note"><span aria-hidden="true">只读</span><p>当前账号仅可查看已发布商品，导入、审核和设置入口已隐藏。</p></div>}
          <div className="sidebar-footer"><div className="user-chip"><div className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</div><div><strong>{user.username}</strong><RoleBadge role={user.role} /></div></div><button type="button" className="logout-button" onClick={() => void logout}><LogoutIcon size={17} />退出</button></div>
        </aside>
        <div className="shell-main">
          <header className="topbar"><button className="icon-button menu-button" type="button" aria-label="打开导航" onClick={() => setMobileOpen(true)}><MenuIcon size={22} /></button><div className="breadcrumb"><span>佳旺商品库</span><span aria-hidden="true">/</span><strong>{visibleNav.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.label || "管理台"}</strong></div><div className="topbar-actions"><span className="network-indicator"><i aria-hidden="true" />内网模式</span><span className="topbar-date">{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date())}</span></div></header>
          <main className="page-content">{children}</main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
