"use client";

import Link from "next/link";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportJob } from "../../lib/contracts/pipeline";
import { AppShell, useSession } from "../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson, asList } from "../../components/api-client";
import { RefreshIcon, UploadIcon } from "../../components/icon";
import { EmptyState, ErrorState, LoadingBlock, Notice, ProgressBar, SectionHeader, StatusBadge } from "../../components/ui";


const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
// Keep the browser guard aligned with the server's documented 4 GiB default;
// the server remains authoritative when deployment limits are tightened.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

type UploadEntryStatus = "waiting" | "uploading" | "processing" | "completed" | "failed";

interface UploadEntry {
  localId: string;
  file: File;
  status: UploadEntryStatus;
  progress: number;
  message?: string;
  uploadId?: string;
  jobId?: string;
  error?: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function extractId(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  for (const key of ["upload", "job", "data"]) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const found = extractId(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function extractJob(payload: unknown): ImportJob | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.id && (record.status || record.totalItems !== undefined)) return record as unknown as ImportJob;
  for (const key of ["job", "data"]) {
    const nested = record[key];
    const result = extractJob(nested);
    if (result) return result;
  }
  return undefined;
}

async function digestFile(file: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

function formatTime(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function ImportsContent() {
  const { user } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadControllers = useRef<Map<string, AbortController>>(new Map());
  const eventSources = useRef<Map<string, EventSource>>(new Map());
  const refreshTimer = useRef<number | null>(null);
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);

  const updateEntry = useCallback((localId: string, patch: Partial<UploadEntry>) => {
    setEntries((current) => current.map((entry) => entry.localId === localId ? { ...entry, ...patch } : entry));
  }, []);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    setJobsError(null);
    if (user?.role === "viewer") {
      setJobs([]);
      setLoadingJobs(false);
      return;
    }
    try {
      const payload = await apiFetch<unknown>("/api/v1/import-jobs?limit=20", { cache: "no-store" });
      setJobs(asList<ImportJob>(payload, ["jobs", "items", "records"]));
    } catch (cause) {
      setJobsError(apiErrorMessage(cause));
    } finally {
      setLoadingJobs(false);
    }
  }, [user?.role]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);
  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ available?: boolean; vision?: boolean }>("/api/v1/ai/capabilities", { cache: "no-store" }).then((value) => { if (!cancelled) setAiAvailable(value.available === true && value.vision === true); }).catch(() => { if (!cancelled) setAiAvailable(null); });
    return () => { cancelled = true; };
  }, []);

  // Refresh persisted progress while any task is active. This also acts as a
  // fallback when a reverse proxy cannot keep an SSE connection open. The
  // server remains the source of truth; local progress is only for bytes
  // currently uploading.
  useEffect(() => {
    const hasProcessingUpload = entries.some((entry) => entry.status === "processing");
    const hasActiveJob = jobs.some((job) => ["queued", "running", "paused", "cancelling"].includes(job.status));
    if (!hasProcessingUpload && !hasActiveJob) return;
    const timer = window.setInterval(() => { void loadJobs(); }, 4000);
    return () => window.clearInterval(timer);
  }, [entries, jobs, loadJobs]);

  // Subscribe to the server's durable event stream for active jobs. Polling
  // remains as a fallback when a reverse proxy does not support SSE.
  useEffect(() => {
    const activeIds = new Set(jobs.filter((job) => ["queued", "running", "paused", "cancelling"].includes(job.status)).map((job) => job.id));
    for (const [jobId, source] of eventSources.current) {
      if (!activeIds.has(jobId)) { source.close(); eventSources.current.delete(jobId); }
    }
    for (const jobId of activeIds) {
      if (eventSources.current.has(jobId)) continue;
      const source = new EventSource(`/api/v1/import-jobs/${encodeURIComponent(jobId)}/events`);
      const handleEvent = (event: MessageEvent, eventName = "message") => {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(event.data) as Record<string, unknown>; } catch { /* heartbeat or non-json event */ }
        const isJobEvent = eventName === "message" || eventName.startsWith("job.") || eventName === "budget.updated";
        if (isJobEvent && (typeof data.status === "string" || typeof data.completedItems === "number" || typeof data.failedItems === "number" || typeof data.usedTokens === "number")) {
          setJobs((current) => current.map((job) => job.id === jobId ? { ...job, ...data } as ImportJob : job));
        } else if (refreshTimer.current === null) {
          refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void loadJobs(); }, 800);
        }
      };
      source.onmessage = (event) => handleEvent(event);
      for (const eventName of ["job.created", "job.started", "job.progress", "job.paused", "job.cancelled", "job.completed", "job.failed", "item.updated", "review.required", "budget.updated"]) source.addEventListener(eventName, (event) => handleEvent(event as MessageEvent, eventName));
      source.onerror = () => { source.close(); eventSources.current.delete(jobId); };
      eventSources.current.set(jobId, source);
    }
  }, [jobs, loadJobs]);

  useEffect(() => {
    const sources = eventSources.current;
    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    setGlobalError(null);
    const next: UploadEntry[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".zip")) { setGlobalError("仅支持 ZIP 文件。图片应先整理到 ZIP 后再上传。"); continue; }
      if (file.size <= 0) { setGlobalError(`${file.name} 为空文件，无法上传。`); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { setGlobalError(`${file.name} 超过 4 GiB 上传上限。`); continue; }
      next.push({ localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`, file, status: "waiting", progress: 0 });
    }
    if (next.length) setEntries((current) => [...current, ...next]);
  }, []);

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files) addFiles(event.dataTransfer.files);
  }

  async function uploadEntry(entry: UploadEntry) {
    const { file } = entry;
    const controller = new AbortController();
    uploadControllers.current.set(entry.localId, controller);
    updateEntry(entry.localId, { status: "uploading", progress: 0, error: undefined, message: "正在创建上传会话…" });
    const chunkSize = DEFAULT_CHUNK_SIZE;
    const expectedChunks = Math.ceil(file.size / chunkSize);
    try {
      const created = await apiFetch<unknown>("/api/v1/uploads", { method: "POST", body: JSON.stringify({ filename: file.name, expectedBytes: file.size, expectedChunks, chunkSize, mimeType: file.type || "application/zip" }), signal: controller.signal });
      const uploadId = extractId(created, ["id", "uploadId"]);
      if (!uploadId) throw new Error("服务端没有返回上传会话 ID");
      updateEntry(entry.localId, { uploadId, message: `已创建会话，共 ${expectedChunks} 个分块` });
      for (let index = 0; index < expectedChunks; index += 1) {
        const chunk = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
        const digest = await digestFile(chunk);
        await apiFetch<unknown>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, { method: "PUT", body: chunk, headers: digest ? { "x-chunk-sha256": digest } : undefined, signal: controller.signal });
        updateEntry(entry.localId, { progress: Math.round(((index + 1) / expectedChunks) * 92), message: `已上传 ${index + 1}/${expectedChunks} 个分块` });
      }
      updateEntry(entry.localId, { status: "processing", progress: 96, message: "正在校验并组装文件…" });
      // The server always hashes the assembled stream. Avoid buffering a very
      // large archive a second time in the browser merely to send an optional
      // client digest.
      const sha256 = file.size <= 128 * 1024 * 1024 ? await digestFile(file) : undefined;
      const completed = await apiFetch<unknown>(`/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST", body: JSON.stringify(sha256 ? { sha256 } : {}), signal: controller.signal });
      let job = extractJob(completed);
      let jobId = extractId(completed, ["jobId"]);
      // Some deployments expose job creation as a separate, explicit step.
      if (!job && !jobId) {
        try {
          const createdJob = await apiFetch<unknown>("/api/v1/import-jobs", { method: "POST", body: JSON.stringify({ uploadId }), signal: controller.signal });
          job = extractJob(createdJob);
          jobId = extractId(createdJob, ["jobId", "id"]);
        } catch {
          // Do not present a false success. The upload is complete, but the UI
          // keeps the item in a visible "等待任务" state until a job exists.
        }
      }
      updateEntry(entry.localId, { status: "completed", progress: 100, jobId: jobId || job?.id, message: job ? "任务已创建，等待处理" : "文件已上传，等待服务端创建任务" });
      if (job) setJobs((current) => [job as ImportJob, ...current.filter((item) => item.id !== job?.id)]);
      else void loadJobs();
    } catch (cause) {
      if (!controller.signal.aborted) updateEntry(entry.localId, { status: "failed", error: apiErrorMessage(cause, "上传失败，请检查文件和内网连接"), message: "服务端未确认完成" });
    } finally {
      uploadControllers.current.delete(entry.localId);
    }
  }

  async function cancelEntry(entry: UploadEntry) {
    uploadControllers.current.get(entry.localId)?.abort();
    if (!entry.uploadId) { setEntries((current) => current.filter((item) => item.localId !== entry.localId)); return; }
    try { await apiJson(`/api/v1/uploads/${encodeURIComponent(entry.uploadId)}`, "DELETE"); } catch (cause) { updateEntry(entry.localId, { error: apiErrorMessage(cause) }); return; }
    setEntries((current) => current.filter((item) => item.localId !== entry.localId));
  }

  async function runJob(job: ImportJob) {
    setActionJobId(job.id); setJobsError(null);
    try {
      const payload = await apiJson<unknown>(`/api/v1/import-jobs/${encodeURIComponent(job.id)}`, "POST");
      const updated = extractJob(payload);
      if (updated) setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      else void loadJobs();
    } catch (cause) { setJobsError(apiErrorMessage(cause, "任务启动失败，服务端未确认运行")); }
    finally { setActionJobId(null); }
  }

  async function cancelJob(job: ImportJob) {
    setActionJobId(job.id); setJobsError(null);
    try {
      const payload = await apiFetch<unknown>(`/api/v1/import-jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      const updated = extractJob(payload);
      if (updated) setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      else void loadJobs();
    } catch (cause) { setJobsError(apiErrorMessage(cause, "取消任务失败，服务端未确认")); }
    finally { setActionJobId(null); }
  }

  async function controlJob(job: ImportJob, action: "pause" | "resume" | "retry") {
    setActionJobId(job.id); setJobsError(null);
    try {
      const payload = await apiJson<unknown>(`/api/v1/import-jobs/${encodeURIComponent(job.id)}/${action}`, "POST", action === "pause" ? { reason: "由操作员暂停" } : {});
      const updated = extractJob(payload);
      if (updated) setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      else void loadJobs();
    } catch (cause) { setJobsError(apiErrorMessage(cause, "任务状态更新失败，服务端未确认")); }
    finally { setActionJobId(null); }
  }

  const activeJobIds = useMemo(() => new Set(entries.map((entry) => entry.jobId).filter(Boolean)), [entries]);

  if (user?.role === "viewer") {
    return <Notice tone="warning">只读账号不能发起导入。服务端也会拒绝上传请求。</Notice>;
  }

  return (
    <>
      <SectionHeader eyebrow="INGEST" title="导入任务" description="上传包含商品多角度图片的 ZIP。文件会先分块传输并校验完整性，再交给后台任务处理。" actions={<button className="button button-secondary" type="button" onClick={() => void loadJobs()} disabled={loadingJobs}><RefreshIcon size={15} />刷新任务</button>} />
      {globalError && <Notice tone="danger">{globalError}</Notice>}
      {aiAvailable === false && <Notice tone="warning">当前激活的 AI 配置不可用，新任务会进入人工审核。</Notice>}
      <div className="upload-layout">
        <section className="card"><div className="card-header"><div><h2>选择 ZIP 文件</h2><p>使用管理员当前激活的模型档案</p></div></div><div className="card-body"><div className={`dropzone${dragActive ? " drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }} onDrop={onDrop} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}><UploadIcon size={25} /><div><strong>拖入 ZIP 文件</strong><p>单个文件不超过 4 GiB，仅接受 .zip</p><button className="button button-primary" type="button" onClick={() => inputRef.current?.click()}>选择文件</button><input ref={inputRef} type="file" accept=".zip,application/zip" multiple onChange={onInput} aria-label="选择 ZIP 文件" /></div></div>
          {entries.length > 0 && <div className="file-queue" aria-label="待上传文件列表">{entries.map((entry) => <div className="file-item" key={entry.localId}><div className="file-icon" aria-hidden="true">ZIP</div><div className="file-item-main"><div className="file-item-name" title={entry.file.name}>{entry.file.name}</div><div className="file-item-size">{formatBytes(entry.file.size)}{entry.message ? ` · ${entry.message}` : ""}</div>{entry.status === "uploading" && <ProgressBar value={entry.progress} label={`${entry.progress}%`} />}{entry.status === "processing" && <ProgressBar indeterminate label="服务端处理中" />}{entry.error && <p className="field-error">{entry.error}</p>}</div><StatusBadge status={entry.status === "waiting" ? "created" : entry.status === "processing" ? "running" : entry.status === "completed" ? "succeeded" : entry.status === "failed" ? "failed" : "uploading"} label={entry.status === "waiting" ? "待上传" : entry.status === "uploading" ? "上传中" : entry.status === "processing" ? "处理中" : entry.status === "completed" ? "已提交" : "失败"} />{entry.status === "waiting" || entry.status === "failed" ? <button className="button button-secondary" type="button" onClick={() => void uploadEntry(entry)}>{entry.status === "failed" ? "重试" : "开始"}</button> : entry.status !== "completed" ? <button className="button button-quiet" type="button" onClick={() => void cancelEntry(entry)}>取消</button> : <span className="file-item-status">{entry.jobId ? `任务 ${entry.jobId.slice(0, 8)}` : "等待任务"}</span>}</div>)}</div>}
        </div></section>
        <aside className="card"><div className="card-header"><div><h2>上传前须知</h2><p>安全检查由服务端执行</p></div></div><div className="card-body requirements"><div className="requirement">压缩包内只放商品图片（JPG、PNG、WebP）</div><div className="requirement">系统会拒绝路径穿越、压缩炸弹和超大图片</div><div className="requirement">原图不会公开到 public 目录，访问受权限保护</div><div className="requirement">AI 仅生成建议，人工审核通过后才能发布</div><div className="requirement">上传中请保持页面打开；断点状态由服务端保留</div></div></aside>
      </div>
      <section className="card" style={{ marginTop: 18 }}><div className="card-header"><div><h2>任务进度 / Token 看板</h2><p>服务端状态会定期刷新；失败任务不会被标记为成功</p></div></div>{loadingJobs ? <LoadingBlock label="正在读取任务…" /> : jobsError ? <ErrorState message={jobsError} onRetry={() => void loadJobs()} /> : jobs.length === 0 ? <EmptyState title="暂无任务记录" description="完成一次上传后，任务状态会显示在这里。" /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>任务</th><th>状态</th><th>处理进度</th><th>Token</th><th>更新时间</th><th /></tr></thead><tbody>{jobs.map((job) => { const progress = job.totalItems > 0 ? Math.round(((job.completedItems + job.failedItems) / job.totalItems) * 100) : 0; const active = activeJobIds.has(job.id); const canRun = job.status === "queued"; const canPause = ["queued", "running"].includes(job.status); const canResume = job.status === "paused"; const canRetry = ["failed", "cancelled"].includes(job.status); const canCancel = ["queued", "running", "paused"].includes(job.status); return <tr key={job.id}><td data-label="任务"><span className="table-primary mono">{job.id.slice(0, 12)}</span><span className="table-secondary">{job.totalItems} 个条目{active ? " · 刚刚上传" : ""}</span></td><td data-label="状态"><StatusBadge status={job.status} />{job.error && <span className="table-secondary">{job.error.message}</span>}</td><td data-label="处理进度"><ProgressBar value={progress} label={`${progress}%`} /></td><td data-label="Token"><span className="mono">{(job.usedTokens ?? 0).toLocaleString("zh-CN")}</span><span className="table-secondary">预留 {(job.reservedTokens ?? 0).toLocaleString("zh-CN")}</span></td><td data-label="更新时间" className="muted">{formatTime(job.updatedAt)}</td><td data-label="操作" className="table-actions">{canRun && <button className="button button-secondary" type="button" disabled={actionJobId === job.id} onClick={() => void runJob(job)}>{actionJobId === job.id ? "处理中…" : "运行"}</button>}{canPause && <button className="button button-quiet" type="button" disabled={actionJobId === job.id} onClick={() => void controlJob(job, "pause")}>暂停</button>}{canResume && <button className="button button-secondary" type="button" disabled={actionJobId === job.id} onClick={() => void controlJob(job, "resume")}>恢复</button>}{canRetry && <button className="button button-secondary" type="button" disabled={actionJobId === job.id} onClick={() => void controlJob(job, "retry")}>重试</button>}{canCancel && <button className="button button-quiet" type="button" disabled={actionJobId === job.id} onClick={() => void cancelJob(job)}>取消</button>}<Link className="button button-quiet" href={`/imports/${encodeURIComponent(job.id)}`}>查看</Link></td></tr>; })}</tbody></table></div>}</section>
    </>
  );
}

export default function ImportsPage() {
  return <AppShell active="/imports"><ImportsContent /></AppShell>;
}
