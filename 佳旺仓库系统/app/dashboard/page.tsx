"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ImportJob, ProviderCapabilities } from "../../lib/contracts/pipeline";
import { AppShell, useSession } from "../../components/app-shell";
import { apiErrorMessage, apiFetch, asList } from "../../components/api-client";
import { AlertIcon, CatalogIcon, RefreshIcon, ReviewIcon, SparkIcon, UploadIcon } from "../../components/icon";
import { EmptyState, ErrorState, LoadingBlock, MetricCard, Notice, ProgressBar, SectionHeader, StatusBadge } from "../../components/ui";

interface CollectionPayload<T> {
  items?: T[];
  jobs?: T[];
  products?: T[];
  total?: number;
  count?: number;
  totalPublished?: number;
}

interface DashboardState {
  jobs: ImportJob[];
  publishedTotal: number | null;
  reviewTotal: number | null;
  capabilities: ProviderCapabilities | null;
  errors: string[];
}

const initialState: DashboardState = { jobs: [], publishedTotal: null, reviewTotal: null, capabilities: null, errors: [] };

function collectionTotal(payload: unknown, fallbackItems: unknown[]): number | null {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["total", "count", "totalPublished", "totalItems"]) {
      if (typeof record[key] === "number") return record[key] as number;
    }
  }
  return fallbackItems.length;
}

function formatTime(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function DashboardContent() {
  const { user } = useSession();
  const [state, setState] = useState<DashboardState>(initialState);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [jobsResult, catalogResult, reviewResult, aiResult] = await Promise.allSettled([
      user?.role === "viewer" ? Promise.resolve(null) : apiFetch<CollectionPayload<ImportJob> | ImportJob[]>("/api/v1/import-jobs?limit=8", { cache: "no-store" }),
      apiFetch<CollectionPayload<unknown> | unknown[]>("/api/v1/catalog/products?status=published&limit=1", { cache: "no-store" }),
      user?.role === "viewer" ? Promise.resolve(null) : apiFetch<CollectionPayload<unknown> | unknown[]>("/api/v1/reviews", { cache: "no-store" }),
      apiFetch<ProviderCapabilities>("/api/v1/ai/capabilities", { cache: "no-store" }),
    ]);

    const errors: string[] = [];
    const jobs = jobsResult.status === "fulfilled" ? asList<ImportJob>(jobsResult.value, ["jobs", "items", "records"]) : [];
    if (jobsResult.status === "rejected") errors.push(`任务：${apiErrorMessage(jobsResult.reason)}`);
    const catalogItems = catalogResult.status === "fulfilled" ? asList<unknown>(catalogResult.value, ["products", "items", "records"]) : [];
    const publishedTotal = catalogResult.status === "fulfilled" ? collectionTotal(catalogResult.value, catalogItems) : null;
    if (catalogResult.status === "rejected") errors.push(`商品库：${apiErrorMessage(catalogResult.reason)}`);
    const reviewItems = reviewResult.status === "fulfilled" && reviewResult.value ? asList<unknown>(reviewResult.value, ["items", "records", "results"]) : [];
    const reviewTotal = user?.role === "viewer" ? null : reviewResult.status === "fulfilled" && reviewResult.value ? collectionTotal(reviewResult.value, reviewItems) : null;
    if (reviewResult.status === "rejected") errors.push(`审核队列：${apiErrorMessage(reviewResult.reason)}`);
    const capabilities = aiResult.status === "fulfilled" ? aiResult.value : null;
    if (aiResult.status === "rejected") errors.push(`AI 状态：${apiErrorMessage(aiResult.reason)}`);
    setState({ jobs, publishedTotal, reviewTotal, capabilities, errors });
    setLoading(false);
  }, [user?.role]);

  useEffect(() => { void load(); }, [load]);

  const metrics = useMemo(() => {
    const running = state.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
    const failed = state.jobs.filter((job) => job.status === "failed").length;
    const usedTokens = state.jobs.reduce((sum, job) => sum + (job.usedTokens || 0), 0);
    const reservedTokens = state.jobs.reduce((sum, job) => sum + (job.reservedTokens || 0), 0);
    const estimatedCostMinor = state.jobs.reduce((sum, job) => sum + (job.estimatedCostMinor || 0), 0);
    return { running, failed, usedTokens, reservedTokens, estimatedCostMinor };
  }, [state.jobs]);

  return (
    <>
      <SectionHeader eyebrow="TODAY'S OVERVIEW" title={`早上好，${user?.username || ""}`} description="这里汇总导入、人工审核与发布情况。AI 识别只提供建议，商品必须经人工审核后才能发布。" actions={<button type="button" className="button button-secondary" onClick={() => void load()} disabled={loading}><RefreshIcon size={15} />刷新数据</button>} />
      {state.capabilities && !(state.capabilities.available && state.capabilities.vision) && <Notice tone="warning"><AlertIcon size={16} />AI 当前不可用：{state.capabilities.reason || "尚未完成视觉模型配置"}。导入仍可继续，相关图片会进入人工处理队列。</Notice>}
      {state.errors.length > 0 && <Notice tone="danger"><AlertIcon size={16} /><span>部分数据未能加载：{state.errors.join("；")}</span></Notice>}
      <section className="metric-grid" aria-label="关键指标">
        <MetricCard label="进行中的任务" value={user?.role === "viewer" ? "—" : loading ? "…" : metrics.running} detail={user?.role === "viewer" ? "只读账号不显示任务数据" : metrics.failed ? `${metrics.failed} 个任务失败` : "队列状态正常"} tone={metrics.failed ? "red" : "blue"} />
        <MetricCard label="待人工审核" value={loading ? "…" : state.reviewTotal ?? "—"} detail={user?.role === "viewer" ? "只读账号不可进入审核" : "AI 结果尚未发布"} tone="amber" />
        <MetricCard label="已发布商品" value={loading ? "…" : state.publishedTotal ?? "—"} detail="仅已发布数据可导出" tone="green" />
        <MetricCard label="本页任务 Token" value={user?.role === "viewer" ? "—" : loading ? "…" : metrics.usedTokens.toLocaleString("zh-CN")} detail={user?.role === "viewer" ? "只读账号不显示用量" : metrics.reservedTokens ? `已预留 ${metrics.reservedTokens.toLocaleString("zh-CN")}` : "暂无预留记录"} tone="blue" />
        <MetricCard label="本页估算费用" value={user?.role === "viewer" ? "—" : loading ? "…" : `${metrics.estimatedCostMinor.toLocaleString("zh-CN")} 计费单位`} detail="按当前价格版本结算；未知用量不会按 0 计费" tone="amber" />
      </section>

      <div className="dashboard-grid">
        <section className="card" aria-labelledby="recent-jobs-title">
          <div className="card-header"><div><h2 id="recent-jobs-title">最近导入任务</h2><p>进度和 token 使用由服务端持久化</p></div>{user?.role !== "viewer" && <Link href="/imports" className="button button-quiet">查看全部</Link>}</div>
          {user?.role === "viewer" ? <div className="card-body"><Notice tone="info">只读账号仅可查看已发布商品，导入任务和处理用量不会在这里显示。</Notice></div> : loading ? <LoadingBlock label="正在读取任务…" /> : state.jobs.length ? <div className="job-list">{state.jobs.map((job) => {
            const progress = job.totalItems > 0 ? Math.round(((job.completedItems + job.failedItems) / job.totalItems) * 100) : 0;
            return <Link className="job-row" href={`/imports/${encodeURIComponent(job.id)}`} key={job.id}><div><div className="job-title">任务 {job.id.slice(0, 8)}</div><div className="job-meta">{formatTime(job.updatedAt)} · {job.provider || "未选择 AI"}</div></div><StatusBadge status={job.status} /><div className="job-progress"><ProgressBar value={progress} label={`${progress}%`} /></div></Link>;
          })}</div> : state.errors.some((item) => item.startsWith("任务：")) ? <ErrorState message="任务接口暂时不可用" onRetry={() => void load()} /> : <EmptyState title="还没有导入任务" description="上传一个商品图片 ZIP，任务会在这里显示。" action={<Link className="button button-primary" href="/imports">开始导入</Link>} />}
        </section>

        <aside>
          <section className="card"><div className="card-header"><div><h2>常用入口</h2><p>根据账号角色显示</p></div></div><div className="card-body quick-actions">
            {user?.role !== "viewer" && <Link className="quick-action" href="/imports"><span className="quick-action-icon"><UploadIcon size={16} /></span><span><strong>上传商品图片</strong><small>ZIP 分块上传</small></span></Link>}
            {user?.role !== "viewer" && <Link className="quick-action" href="/review"><span className="quick-action-icon"><ReviewIcon size={16} /></span><span><strong>处理审核队列</strong><small>确认分组与字段</small></span></Link>}
            <Link className="quick-action" href="/catalog"><span className="quick-action-icon"><CatalogIcon size={16} /></span><span><strong>查看商品库</strong><small>筛选已发布商品</small></span></Link>
          </div></section>
          <section className="card token-card"><div className="card-header"><div><h2>AI 用量</h2><p>{state.capabilities?.model || "视觉模型未确认"}</p></div><SparkIcon size={17} /></div><div className="card-body"><div className="token-usage"><strong>{user?.role === "viewer" ? "—" : metrics.usedTokens.toLocaleString("zh-CN")}</strong><span>{user?.role === "viewer" ? "只读账号不显示用量" : "已用 token"}</span></div><ProgressBar value={user?.role === "viewer" ? 0 : state.capabilities?.available && state.capabilities?.vision && metrics.reservedTokens ? metrics.usedTokens / metrics.reservedTokens * 100 : 0} label={user?.role === "viewer" ? "—" : metrics.reservedTokens ? `${Math.min(100, Math.round(metrics.usedTokens / metrics.reservedTokens * 100))}%` : "—"} /><Notice tone={state.capabilities?.available && state.capabilities?.vision ? "success" : "warning"}>{state.capabilities?.available && state.capabilities?.vision ? "AI 能力探测通过" : state.capabilities ? "AI 不可用，任务将转人工" : "尚未取得 AI 能力状态"}</Notice></div></section>
        </aside>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return <AppShell active="/dashboard"><DashboardContent /></AppShell>;
}
