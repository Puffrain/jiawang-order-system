"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportItem, ImportJob } from "../../../lib/contracts/pipeline";
import { AppShell, useSession } from "../../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson } from "../../../components/api-client";
import { AlertIcon, RefreshIcon } from "../../../components/icon";
import { EmptyState, ErrorState, LoadingBlock, Notice, ProgressBar, SectionHeader, StatusBadge } from "../../../components/ui";

interface JobDetailPayload { job: ImportJob; items: ImportItem[]; budget?: { reservedTokens?: number; usedTokens?: number; costMinor?: number; usageKnown?: boolean; priceVersion?: string; currency?: string } | null }

function formatTime(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function canRetryItem(item: ImportItem) {
  if (item.error?.code === "REVIEW_REJECTED") return false;
  return item.status === "failed" || item.status === "cancelled" || (item.status === "needs_review" && item.error?.code === "REVIEW_NEEDS_CHANGES");
}

function JobDetailContent({ jobId }: { jobId: string }) {
  const { user } = useSession();
  const [payload, setPayload] = useState<JobDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setPayload(await apiFetch<JobDetailPayload>(`/api/v1/import-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" })); }
    catch (cause) { setError(apiErrorMessage(cause, "任务详情暂时不可用")); }
    finally { setLoading(false); }
  }, [jobId]);
  useEffect(() => { if (user?.role !== "viewer") void load(); }, [load, user?.role]);

  const jobStatus = payload?.job.status;
  useEffect(() => {
    if (!["queued", "running", "paused", "cancelling"].includes(jobStatus || "")) return;
    const source = new EventSource(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/events`);
    sourceRef.current = source;
    const refresh = () => { void load(); };
    source.onmessage = refresh;
    for (const eventName of ["job.created", "job.started", "job.progress", "job.paused", "job.cancelled", "job.completed", "job.failed", "item.updated", "review.required", "budget.updated"]) source.addEventListener(eventName, refresh as EventListener);
    source.onerror = () => { source.close(); sourceRef.current = null; };
    // Keep a bounded polling fallback for deployments where a reverse proxy
    // buffers or drops SSE. The server remains the source of truth.
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => { source.close(); sourceRef.current = null; window.clearInterval(timer); };
  }, [jobStatus, jobId, load]);

  async function run() {
    setActionBusy(true); setError(null);
    try { await apiJson(`/api/v1/import-jobs/${encodeURIComponent(jobId)}`, "POST"); await load(); }
    catch (cause) { setError(apiErrorMessage(cause, "任务启动失败，服务端未确认运行")); }
    finally { setActionBusy(false); }
  }
  async function cancel() {
    setActionBusy(true); setError(null);
    try { await apiFetch(`/api/v1/import-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }); await load(); }
    catch (cause) { setError(apiErrorMessage(cause, "取消任务失败，服务端未确认")); }
    finally { setActionBusy(false); }
  }

  async function control(action: "pause" | "resume" | "retry", itemId?: string) {
    setActionBusy(true); setError(null);
    if (action === "retry" && itemId) {
      try { await apiJson(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/${action}`, "POST", { itemId }); await load(); }
      catch (cause) { setError(apiErrorMessage(cause, "Item retry failed")); }
      finally { setActionBusy(false); }
      return;
    }
    try { await apiJson(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/${action}`, "POST", action === "pause" ? { reason: "由操作员暂停" } : {}); await load(); }
    catch (cause) { setError(apiErrorMessage(cause, "任务状态更新失败，服务端未确认")); }
    finally { setActionBusy(false); }
  }

  if (user?.role === "viewer") return <Notice tone="warning">只读账号不能查看导入任务详情；请前往商品库查看已发布数据。</Notice>;
  if (loading) return <LoadingBlock label="正在读取任务详情…" />;
  if (error && !payload) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!payload) return <EmptyState title="找不到任务" description="任务可能已被清理，或当前账号没有查看权限。" />;
  const { job, items, budget } = payload;
  const progress = job.totalItems > 0 ? Math.round(((job.completedItems + job.failedItems) / job.totalItems) * 100) : 0;
  const usedTokens = job.usedTokens ?? budget?.usedTokens ?? 0;
  const reservedTokens = job.reservedTokens ?? budget?.reservedTokens ?? 0;
  const costMinor = job.estimatedCostMinor ?? budget?.costMinor ?? 0;
  return <>
    <SectionHeader eyebrow="IMPORT JOB" title={`任务 ${job.id.slice(0, 12)}`} description={`创建于 ${formatTime(job.createdAt)} · 最近更新 ${formatTime(job.updatedAt)}`} actions={<><button className="button button-secondary" type="button" onClick={() => void load()} disabled={actionBusy}><RefreshIcon size={15} />刷新</button>{job.status === "queued" && <button className="button button-primary" type="button" onClick={() => void run()} disabled={actionBusy}>{actionBusy ? "处理中…" : "运行任务"}</button>}{["queued", "running"].includes(job.status) && <button className="button button-quiet" type="button" onClick={() => void control("pause")} disabled={actionBusy}>暂停</button>}{job.status === "paused" && <button className="button button-primary" type="button" onClick={() => void control("resume")} disabled={actionBusy}>恢复任务</button>}{["failed", "cancelled"].includes(job.status) && !items.every((item) => item.error?.code === "REVIEW_REJECTED") && <button className="button button-secondary" type="button" onClick={() => void control("retry")} disabled={actionBusy}>重试任务</button>}{["queued", "running", "paused"].includes(job.status) && <button className="button button-danger" type="button" onClick={() => void cancel()} disabled={actionBusy}>取消任务</button>}</>} />
    {error && <Notice tone="danger"><AlertIcon size={15} />{error}</Notice>}
    <div className="metric-grid"><div className="metric-card metric-blue"><span className="metric-label">任务状态</span><strong style={{ fontSize: 18 }}><StatusBadge status={job.status} /></strong><span className="metric-detail">Provider：{job.provider || "未指定"}</span></div><div className="metric-card metric-green"><span className="metric-label">条目进度</span><strong>{progress}%</strong><span className="metric-detail">{job.completedItems} 完成 / {job.totalItems} 总数</span></div><div className="metric-card metric-amber"><span className="metric-label">Token 使用</span><strong>{usedTokens.toLocaleString("zh-CN")}</strong><span className="metric-detail">预留 {reservedTokens.toLocaleString("zh-CN")}</span></div><div className="metric-card metric-blue"><span className="metric-label">费用</span><strong>{costMinor.toLocaleString("zh-CN")}</strong><span className="metric-detail">{budget?.currency || "CNY"} · {budget?.priceVersion || "未配置价格版本"}{budget?.usageKnown === false ? " · 用量未知已暂停" : ""}</span></div><div className="metric-card metric-red"><span className="metric-label">失败条目</span><strong>{job.failedItems}</strong><span className="metric-detail">失败不会被标记为发布</span></div></div>
    <section className="card"><div className="card-header"><div><h2>处理进度</h2><p>事件流断开时会自动回退到刷新</p></div><ProgressBar value={progress} label={`${progress}%`} /></div><div className="card-body">{job.status === "failed" && <Notice tone="danger"><AlertIcon size={15} />任务失败：{job.error?.message || "服务端未提供详细原因"}</Notice>}{job.status === "succeeded" && <Notice tone="warning">任务处理完成，但 AI 结果仍需人工审核；此状态不等于商品已发布。</Notice>}{job.status === "paused" && <Notice tone="warning">任务已暂停，通常需要补充配置或人工处理后再运行。</Notice>}<div className="progress-track" style={{ height: 10 }}><div className="progress-fill" style={{ width: `${progress}%` }} /></div></div></section>
    <section className="card" style={{ marginTop: 18 }}><div className="card-header"><div><h2>条目状态</h2><p>{items.length} 个图片条目 · 待审核仍需人工决定</p></div></div>{items.length === 0 ? <div className="card-body"><EmptyState title="暂无条目详情" description="服务端尚未生成条目，或任务仍在初始化。" /></div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>条目</th><th>状态</th><th>分类 / 分组</th><th>置信度</th><th>更新时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td data-label="条目"><span className="table-primary mono">{item.id.slice(0, 12)}</span><span className="table-secondary">尝试 {item.attempts} 次</span></td><td data-label="状态"><StatusBadge status={item.status} />{item.error && <span className="table-secondary">{item.error.message}</span>}</td><td data-label="分类 / 分组">{item.category || "—"} / {item.group || "—"}</td><td data-label="置信度">{typeof item.confidence === "number" ? `${Math.round(item.confidence * 100)}%` : "—"}</td><td data-label="更新时间" className="muted">{formatTime(item.updatedAt)}</td></tr>)}</tbody></table></div>}</section>
    {items.some(canRetryItem) && <section className="card" style={{ marginTop: 18 }}><div className="card-header"><div><h2>单条目重试</h2><p>仅重新处理失败、取消或明确退回修改的条目。</p></div></div><div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{items.filter(canRetryItem).map((item) => <button key={item.id} className="button button-secondary" type="button" onClick={() => void control("retry", item.id)} disabled={actionBusy}>重试 {item.id.slice(0, 12)}</button>)}</div></section>}
  </>;
}

export default function ImportJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => { void params.then((value) => setJobId(value.jobId)); }, [params]);
  return <AppShell active="/imports">{jobId ? <JobDetailContent jobId={jobId} /> : <LoadingBlock label="正在打开任务…" />}</AppShell>;
}
