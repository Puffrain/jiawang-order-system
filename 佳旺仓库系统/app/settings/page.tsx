"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { CategoryRecord } from "../../lib/contracts/catalog";
import type { DeepSeekConfigPublic, PublicUser, Role } from "../../lib/contracts/platform";
import type { ProviderCapabilities } from "../../lib/contracts/pipeline";
import { AppShell, useSession } from "../../components/app-shell";
import { apiErrorMessage, apiFetch, apiJson, asList } from "../../components/api-client";
import { AlertIcon, DownloadIcon, RefreshIcon, ShieldIcon, SparkIcon } from "../../components/icon";
import { EmptyState, LoadingBlock, Notice, SectionHeader, StatusBadge } from "../../components/ui";
import { AiProfileSettings } from "../../components/ai-profile-settings";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";

type SettingsTab = "ai" | "users" | "categories" | "backup";
const tabs: Array<{ id: SettingsTab; label: string; hint: string }> = [
  { id: "ai", label: "AI 接入", hint: "模型与能力探测" },
  { id: "users", label: "账号权限", hint: "管理员 / 审核员 / 只读" },
  { id: "categories", label: "类目维护", hint: "发布类目字典" },
  { id: "backup", label: "备份与导出", hint: "加密完整备份" },
];

function nested<T>(payload: unknown, key: string): T | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return value && typeof value === "object" ? value as T : undefined;
}

function configFrom(payload: unknown): DeepSeekConfigPublic | null {
  const value = nested<DeepSeekConfigPublic>(payload, "config") || payload;
  return value && typeof value === "object" && "source" in value ? value as DeepSeekConfigPublic : null;
}

function SettingsContent() {
  const { user } = useSession();
  const [tab, setTab] = useState<SettingsTab>("ai");

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab") as SettingsTab | null;
    if (requested && tabs.some((item) => item.id === requested)) setTab(requested);
  }, []);

  function selectTab(next: SettingsTab) {
    setTab(next);
    window.history.replaceState(null, "", `${basePath}/settings?tab=${next}`);
  }

  if (user?.role !== "admin") return <Notice tone="warning">系统设置仅管理员可见。客户端已隐藏操作，服务端会继续拒绝非管理员请求。</Notice>;
  return <>
    <SectionHeader eyebrow="ADMINISTRATION" title="系统设置" description="管理 AI 接入、内部账号、类目以及加密备份。敏感配置不会在页面回显明文。" />
    <div className="settings-layout"><nav className="card settings-nav" aria-label="设置项目">{tabs.map((item) => <button type="button" key={item.id} className={`settings-tab${tab === item.id ? " settings-tab-active" : ""}`} aria-current={tab === item.id ? "page" : undefined} onClick={() => selectTab(item.id)}><strong>{item.label}</strong><span>{item.hint}</span></button>)}</nav><div>{tab === "ai" && <AiProfileSettings />}{tab === "users" && <UserSettings currentUserId={user.id} />}{tab === "categories" && <CategorySettings />}{tab === "backup" && <BackupSettings />}</div></div>
  </>;
}

function AiSettings() {
  const [config, setConfig] = useState<DeepSeekConfigPublic | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [form, setForm] = useState({
    baseUrl: "", model: "", textModel: "", modelsPath: "/models", chatPath: "/chat/completions",
    inputFormat: "data_url", allowedHosts: "", timeoutMs: "60000", maxTokens: "1024",
    priceVersion: "", promptPriceMinor: "0", completionPriceMinor: "0", currency: "CNY", priceTable: "", apiKey: ""
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const value = configFrom(await apiFetch<unknown>("/api/v1/admin/config", { cache: "no-store" }));
      setConfig(value);
      if (value) setForm((current) => ({ ...current,
        baseUrl: value.baseUrl || "", model: value.model || "", textModel: value.textModel || "",
        modelsPath: value.modelsPath || "/models", chatPath: value.chatPath || "/chat/completions",
        inputFormat: value.inputFormat || "data_url", allowedHosts: value.allowedHosts.join(","),
        timeoutMs: String(value.timeoutMs ?? 60000), maxTokens: String(value.maxTokens ?? 1024),
        priceVersion: value.priceVersion || "", promptPriceMinor: String(value.promptPriceMinor ?? 0),
        completionPriceMinor: String(value.completionPriceMinor ?? 0), currency: value.currency || "CNY", apiKey: ""
        ,priceTable: value.priceTable?.length ? JSON.stringify(value.priceTable, null, 2) : ""
      }));
    } catch (cause) { setError(apiErrorMessage(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null); setSuccess(null);
    try {
      const integer = (value: string) => value.trim() ? Number(value) : undefined;
      let priceTable: unknown[] | undefined;
      if (form.priceTable.trim()) {
        try {
          const parsed: unknown = JSON.parse(form.priceTable);
          if (!Array.isArray(parsed)) throw new Error("priceTable 必须是数组");
          priceTable = parsed;
        } catch (cause) {
          throw new Error(cause instanceof Error ? cause.message : "priceTable JSON 无效");
        }
      }
      const value = configFrom(await apiJson<unknown>("/api/v1/admin/config", "PUT", {
        baseUrl: form.baseUrl.trim() || undefined, model: form.model.trim() || undefined,
        textModel: form.textModel.trim() || undefined, modelsPath: form.modelsPath.trim() || undefined,
        chatPath: form.chatPath.trim() || undefined, inputFormat: form.inputFormat.trim() || undefined,
        allowedHosts: form.allowedHosts.split(",").map((item) => item.trim()).filter(Boolean),
        timeoutMs: integer(form.timeoutMs), maxTokens: integer(form.maxTokens), priceVersion: form.priceVersion.trim() || undefined,
        promptPriceMinor: integer(form.promptPriceMinor), completionPriceMinor: integer(form.completionPriceMinor), currency: form.currency.trim() || undefined, priceTable: priceTable || [],
        ...(form.apiKey ? { apiKey: form.apiKey } : {})
      }));
      setConfig(value); setForm((current) => ({ ...current, apiKey: "" })); setSuccess("配置已由服务端保存。请继续执行能力探测，探测通过前 AI 仍视为不可用。");
    } catch (cause) { setError(apiErrorMessage(cause, "AI 配置未保存")); }
    finally { setSaving(false); }
  }

  async function probe() {
    setProbing(true); setError(null); setSuccess(null);
    try {
      const value = await apiJson<ProviderCapabilities>("/api/v1/ai/probe", "POST");
      setCapabilities(value);
      if (value.available && value.vision) setSuccess("能力探测通过：视觉输入可用。任务仍会进入人工审核。");
      else setError(value.reason || "能力探测未通过，AI 任务将降级为人工处理");
    } catch (cause) { setCapabilities(null); setError(apiErrorMessage(cause, "能力探测失败，AI 仍不可用")); }
    finally { setProbing(false); }
  }

  if (loading) return <section className="card"><LoadingBlock label="正在读取 AI 配置…" /></section>;
  const visionReady = Boolean(capabilities?.available && capabilities.vision);
  return <section className="card"><div className="card-header"><div><h2>DeepSeek 视觉适配器</h2><p>Key 环境变量优先；页面仅显示脱敏指纹</p></div><SparkIcon size={18} /></div><div className="card-body"><Notice tone={visionReady ? "success" : "warning"}>{visionReady ? "视觉能力探测已通过" : "尚未取得有效视觉能力探测结果；此时 AI 任务必须转人工。"}</Notice>{error && <Notice tone="danger"><AlertIcon size={15} />{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}<form className="form-grid" onSubmit={save}><div className="form-grid form-grid-2">
    <div className="field"><label htmlFor="ai-base-url">Base URL</label><input id="ai-base-url" className="input" type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://受信任的服务地址" /><span className="field-hint">生产环境仅允许 HTTPS 与服务端白名单</span></div>
    <div className="field"><label htmlFor="ai-model">视觉模型 ID</label><input id="ai-model" className="input" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="请填写部署确认的模型 ID" /></div>
    <div className="field"><label htmlFor="ai-text-model">文本模型 ID（可选）</label><input id="ai-text-model" className="input" value={form.textModel} onChange={(event) => setForm({ ...form, textModel: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-format">输入格式</label><select id="ai-format" className="select" value={form.inputFormat} onChange={(event) => setForm({ ...form, inputFormat: event.target.value })}><option value="data_url">Data URL</option><option value="bytes">字节对象</option><option value="image_url">兼容 image_url</option></select></div>
    <div className="field"><label htmlFor="ai-models-path">能力探测路径</label><input id="ai-models-path" className="input" value={form.modelsPath} onChange={(event) => setForm({ ...form, modelsPath: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-chat-path">对话路径</label><input id="ai-chat-path" className="input" value={form.chatPath} onChange={(event) => setForm({ ...form, chatPath: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-hosts">允许的主机名（逗号分隔）</label><input id="ai-hosts" className="input" value={form.allowedHosts} onChange={(event) => setForm({ ...form, allowedHosts: event.target.value })} placeholder="api.deepseek.com" /></div>
    <div className="field"><label htmlFor="ai-key">API Key</label><input id="ai-key" className="input" type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={config?.apiKeyConfigured ? `已配置 ${config.apiKeyHint || "（已脱敏）"}，留空不变` : "未配置，留空则使用环境变量"} /><span className="field-hint">不会回显或写入日志；环境变量优先</span></div>
    <div className="field"><label htmlFor="ai-timeout">请求超时（毫秒）</label><input id="ai-timeout" className="input" type="number" min="1000" max="600000" value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-max-tokens">最大输出 token</label><input id="ai-max-tokens" className="input" type="number" min="1" max="1000000" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-price-version">价格版本</label><input id="ai-price-version" className="input" value={form.priceVersion} onChange={(event) => setForm({ ...form, priceVersion: event.target.value })} placeholder="例如 2026-08-01" /></div>
    <div className="field"><label htmlFor="ai-currency">币种</label><input id="ai-currency" className="input" maxLength={3} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></div>
    <div className="field"><label htmlFor="ai-prompt-price">输入价（整数计费单位/token）</label><input id="ai-prompt-price" className="input" type="number" min="0" value={form.promptPriceMinor} onChange={(event) => setForm({ ...form, promptPriceMinor: event.target.value })} /></div>
    <div className="field"><label htmlFor="ai-completion-price">输出价（整数计费单位/token）</label><input id="ai-completion-price" className="input" type="number" min="0" value={form.completionPriceMinor} onChange={(event) => setForm({ ...form, completionPriceMinor: event.target.value })} /></div>
    <div className="field detail-wide"><label htmlFor="ai-price-table">模型价格表（JSON，可选）</label><textarea id="ai-price-table" className="input" rows={4} value={form.priceTable} onChange={(event) => setForm({ ...form, priceTable: event.target.value })} placeholder='[{"model":"vision-model","version":"2026-08-01","currency":"CNY","promptPriceMinor":1,"completionPriceMinor":2}]' /><span className="field-hint">按模型匹配；未匹配时使用无 model 的默认项，再回退到上面的价格字段。</span></div>
  </div><div className="section-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存配置"}</button><button className="button button-secondary" type="button" onClick={() => void probe()} disabled={probing || saving}>{probing ? "探测中…" : "读取能力状态"}</button></div></form></div></section>;
}

function UserSettings({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", role: "reviewer" as Role });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setUsers(asList<PublicUser>(await apiFetch<unknown>("/api/v1/admin/users", { cache: "no-store" }), ["users", "items", "records"])); }
    catch (cause) { setError(apiErrorMessage(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault(); setCreating(true); setError(null);
    try {
      const payload = await apiJson<unknown>("/api/v1/admin/users", "POST", form);
      const created = nested<PublicUser>(payload, "user");
      if (created) setUsers((current) => [...current, created]);
      setForm({ username: "", password: "", role: "reviewer" });
    } catch (cause) { setError(apiErrorMessage(cause, "账号创建失败")); }
    finally { setCreating(false); }
  }

  async function update(target: PublicUser, patch: { role?: Role; isActive?: boolean }) {
    setError(null);
    try {
      const updated = nested<PublicUser>(await apiJson<unknown>(`/api/v1/admin/users/${encodeURIComponent(target.id)}`, "PATCH", patch), "user");
      if (updated) setUsers((current) => current.map((item) => item.id === target.id ? updated : item));
    } catch (cause) { setError(apiErrorMessage(cause, "账号修改失败")); }
  }

  return <section className="card"><div className="card-header"><div><h2>内部账号</h2><p>只读账号的写入入口会隐藏，服务端仍做强制 RBAC</p></div><button className="button button-quiet" type="button" onClick={() => void load()}><RefreshIcon size={14} />刷新</button></div><div className="card-body">{error && <Notice tone="danger">{error}</Notice>}<form className="form-grid form-grid-2 user-create-form" onSubmit={create}><div className="field"><label htmlFor="new-username">新账号</label><input id="new-username" className="input" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="字母、数字、点或下划线" required /></div><div className="field"><label htmlFor="new-role">角色</label><select id="new-role" className="select" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}><option value="reviewer">审核员</option><option value="viewer">只读</option><option value="admin">管理员</option></select></div><div className="field"><label htmlFor="new-password">初始密码</label><input id="new-password" className="input" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 8 个字符" required /></div><div className="field form-submit-field"><button className="button button-primary" type="submit" disabled={creating}>{creating ? "创建中…" : "创建账号"}</button></div></form>{loading ? <LoadingBlock label="正在读取账号…" /> : users.length === 0 ? <EmptyState title="暂无账号数据" description="认证接口未返回账号列表。" /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>{users.map((target) => <tr key={target.id}><td data-label="账号"><span className="table-primary">{target.username}</span>{target.id === currentUserId && <span className="table-secondary">当前账号</span>}</td><td data-label="角色"><select className="select compact-select" aria-label={`修改 ${target.username} 的角色`} value={target.role} disabled={target.id === currentUserId} onChange={(event) => void update(target, { role: event.target.value as Role })}><option value="admin">管理员</option><option value="reviewer">审核员</option><option value="viewer">只读</option></select></td><td data-label="状态"><StatusBadge status={target.isActive ? "published" : "cancelled"} label={target.isActive ? "启用" : "停用"} /></td><td data-label="最近登录" className="muted">{target.lastLoginAt ? new Date(target.lastLoginAt).toLocaleString("zh-CN") : "从未登录"}</td><td data-label="操作"><button className={`button ${target.isActive ? "button-danger" : "button-secondary"}`} type="button" disabled={target.id === currentUserId} onClick={() => void update(target, { isActive: !target.isActive })}>{target.isActive ? "停用" : "启用"}</button></td></tr>)}</tbody></table></div>}</div></section>;
}

function CategorySettings() {
  const [items, setItems] = useState<CategoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", code: "", parentId: "" });
  const load = useCallback(async () => { setLoading(true); setError(null); try { setItems(asList<CategoryRecord>(await apiFetch<unknown>("/api/v1/taxonomy?all=true", { cache: "no-store" }), ["categories", "items", "records"])); } catch (cause) { setError(apiErrorMessage(cause)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) { event.preventDefault(); setError(null); try { const created = nested<CategoryRecord>(await apiJson<unknown>("/api/v1/taxonomy", "POST", { name: form.name.trim(), code: form.code.trim(), parentId: form.parentId || undefined, active: true, sortOrder: items.length }), "category"); if (created) setItems((current) => [...current, created]); setForm({ name: "", code: "", parentId: "" }); } catch (cause) { setError(apiErrorMessage(cause, "类目创建失败")); } }
  async function toggle(category: CategoryRecord) { setError(null); try { await apiJson("/api/v1/taxonomy", "POST", { ...category, active: !category.active }); setItems((current) => current.map((item) => item.id === category.id ? { ...item, active: !item.active } : item)); } catch (cause) { setError(apiErrorMessage(cause, "类目状态未更新")); } }
  async function remove(category: CategoryRecord) { if (!window.confirm(`确定删除类目“${category.name}”吗？删除后无法恢复。`)) return; setError(null); setDeletingCategoryId(category.id); try { await apiFetch(`/api/v1/taxonomy/${encodeURIComponent(category.id)}`, { method: "DELETE" }); setItems((current) => current.filter((item) => item.id !== category.id)); } catch (cause) { setError(apiErrorMessage(cause, "类目删除失败")); } finally { setDeletingCategoryId(null); } }
  return <section className="card"><div className="card-header"><div><h2>类目字典</h2><p>停用类目不会用于新的 AI 建议和商品发布</p></div></div><div className="card-body">{error && <Notice tone="danger">{error}</Notice>}<form className="form-grid form-grid-2" onSubmit={create}><div className="field"><label htmlFor="category-name">类目名称</label><input id="category-name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></div><div className="field"><label htmlFor="category-code">类目编码</label><input id="category-code" className="input" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="如 HAIR_CARE" required /></div><div className="field"><label htmlFor="category-parent">上级类目</label><select id="category-parent" className="select" value={form.parentId} onChange={(event) => setForm({ ...form, parentId: event.target.value })}><option value="">无（顶级类目）</option>{items.filter((item) => !item.parentId && item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><div className="field form-submit-field"><button className="button button-primary" type="submit">添加类目</button></div></form>{loading ? <LoadingBlock label="正在读取类目…" /> : items.length === 0 ? <EmptyState title="暂无类目" description="添加第一个发布类目。" /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>名称</th><th>编码</th><th>层级</th><th>状态</th><th /></tr></thead><tbody>{items.map((category) => { const deleting = deletingCategoryId === category.id; return <tr key={category.id}><td data-label="名称" className="table-primary">{category.name}</td><td data-label="编码" className="mono">{category.code}</td><td data-label="层级">{category.parentId ? "子类目" : "顶级"}</td><td data-label="状态"><StatusBadge status={category.active ? "published" : "cancelled"} label={category.active ? "启用" : "停用"} /></td><td data-label="操作" className="table-actions"><button className="button button-secondary" type="button" disabled={deletingCategoryId !== null} onClick={() => void toggle(category)}>{category.active ? "停用" : "启用"}</button><button className="button button-danger" type="button" disabled={category.code === "pending" || deletingCategoryId !== null} title={category.code === "pending" ? "待定类目是系统保留类目" : "删除类目"} onClick={() => void remove(category)}>{deleting ? "删除中…" : "删除"}</button></td></tr>; })}</tbody></table></div>}</div></section>;
}

interface BackupRecord { id: string; filename?: string; createdAt?: string; bytes?: number; status?: string; downloadable?: boolean }

function BackupSettings() {
  const [items, setItems] = useState<BackupRecord[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [restoreAck, setRestoreAck] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setItems(asList<BackupRecord>(await apiFetch<unknown>("/api/v1/admin/backups", { cache: "no-store" }), ["backups", "items", "records"])); } catch (cause) { setError(apiErrorMessage(cause)); } finally { setLoading(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent) { event.preventDefault(); setError(null); setSuccess(null); if (passphrase.length < 12) { setError("备份密码至少需要 12 个字符"); return; } if (passphrase !== confirm) { setError("两次输入的备份密码不一致"); return; } setCreating(true); try { const created = nested<BackupRecord>(await apiJson<unknown>("/api/v1/admin/backups", "POST", { passphrase }), "backup"); if (created) setItems((current) => [created, ...current]); setPassphrase(""); setConfirm(""); setSuccess("服务端已接受备份请求。只有状态显示完成后才能下载；请将密码单独保管。"); } catch (cause) { setError(apiErrorMessage(cause, "备份未创建，服务端没有确认成功")); } finally { setCreating(false); } }
  async function restore(event: FormEvent) {
    event.preventDefault(); setError(null); setRestoreMessage(null);
    if (!restoreFile) { setError("请选择 .jwbackup 文件"); return; }
    if (restorePassphrase.length < 12) { setError("恢复密码至少需要 12 个字符"); return; }
    if (restorePassphrase !== restoreConfirm) { setError("两次输入的恢复密码不一致"); return; }
    if (restoreAck !== "确认恢复") { setError("请输入“确认恢复”以解锁恢复操作"); return; }
    if (!window.confirm("恢复会先留下当前实例底稿，并进入维护流程。确定继续吗？")) return;
    setRestoring(true);
    try {
      const formData = new FormData(); formData.append("file", restoreFile); formData.append("passphrase", restorePassphrase);
      await apiFetch("/api/v1/admin/backups/restore", { method: "POST", body: formData });
      setRestoreFile(null); setRestorePassphrase(""); setRestoreConfirm(""); setRestoreAck(""); setRestoreMessage("恢复请求已提交，服务端会先校验 manifest 再进入维护流程。请等待恢复任务完成后重新登录。");
    } catch (cause) { setError(apiErrorMessage(cause, "恢复请求未提交，当前实例未改变")); }
    finally { setRestoring(false); }
  }
  return <div className="form-grid"><section className="card"><div className="card-header"><div><h2>加密完整备份</h2><p>包含数据库与媒体 manifest，由管理员手动生成</p></div><ShieldIcon size={18} /></div><div className="card-body"><Notice tone="warning"><AlertIcon size={16} />备份密码丢失后无法恢复。不要把密码写入仓库、配置文件或操作日志。</Notice>{error && <Notice tone="danger">{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}<form className="form-grid form-grid-2" onSubmit={create}><div className="field"><label htmlFor="backup-password">备份密码</label><input id="backup-password" className="input" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={12} placeholder="至少 12 个字符" /></div><div className="field"><label htmlFor="backup-confirm">再次输入</label><input id="backup-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={12} placeholder="重复备份密码" /></div><div className="section-actions"><button className="button button-primary" type="submit" disabled={creating}>{creating ? "正在生成…" : "生成加密备份"}</button><a className="button button-secondary" href="/catalog"><DownloadIcon size={15} />前往商品库导出</a></div></form></div></section><section className="card"><div className="card-header"><div><h2>备份记录</h2><p>运行数据应位于 Docker / WSL2 命名卷，不在 OneDrive</p></div><button type="button" className="button button-quiet" onClick={() => void load()}><RefreshIcon size={14} />刷新</button></div><div className="card-body">{loading ? <LoadingBlock label="正在读取备份记录…" /> : items.length === 0 ? <EmptyState title="暂无可下载备份" description={error ? `备份接口暂不可用：${error}` : "生成完成的备份会显示在这里。"} /> : <div className="backup-list">{items.map((backup) => <div className="backup-item" key={backup.id}><div><strong>{backup.filename || `备份 ${backup.id.slice(0, 8)}`}</strong><span>{backup.createdAt ? new Date(backup.createdAt).toLocaleString("zh-CN") : "时间未知"}{backup.bytes ? ` · ${(backup.bytes / 1024 / 1024).toFixed(1)} MB` : ""}</span></div><div className="section-actions"><StatusBadge status={backup.status || "queued"} />{backup.downloadable && <a className="button button-secondary" href={`/api/v1/admin/backups/${encodeURIComponent(backup.id)}/download`}><DownloadIcon size={14} />下载</a>}</div></div>)}</div>}</div></section><section className="card"><div className="card-header"><div><h2>恢复实例</h2><p>高风险操作：恢复前会自动保留当前实例底稿</p></div></div><div className="card-body"><Notice tone="danger"><AlertIcon size={16} />仅在确认备份来源可信时恢复。恢复期间服务可能进入维护状态，完成后需要重新登录。</Notice>{restoreMessage && <Notice tone="success">{restoreMessage}</Notice>}<form className="form-grid form-grid-2" onSubmit={restore}><div className="field"><label htmlFor="restore-file">.jwbackup 文件</label><input id="restore-file" className="input" type="file" accept=".jwbackup,application/octet-stream" onChange={(event) => setRestoreFile(event.target.files?.[0] || null)} /></div><div className="field"><label htmlFor="restore-passphrase">恢复密码</label><input id="restore-passphrase" className="input" type="password" autoComplete="off" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} minLength={12} /></div><div className="field"><label htmlFor="restore-confirm">再次输入密码</label><input id="restore-confirm" className="input" type="password" autoComplete="off" value={restoreConfirm} onChange={(event) => setRestoreConfirm(event.target.value)} minLength={12} /></div><div className="field"><label htmlFor="restore-ack">输入“确认恢复”</label><input id="restore-ack" className="input" value={restoreAck} onChange={(event) => setRestoreAck(event.target.value)} placeholder="请输入确认恢复" /></div><div className="section-actions"><button className="button button-danger" type="submit" disabled={restoring || restoreAck !== "确认恢复"}>{restoring ? "提交恢复…" : "提交恢复请求"}</button></div></form></div></section></div>;
}

export default function SettingsPage() {
  return <AppShell active="/settings"><SettingsContent /></AppShell>;
}
