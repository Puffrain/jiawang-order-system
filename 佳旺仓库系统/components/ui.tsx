import type { ReactNode } from "react";

export type StatusValue = string | undefined | null;

const statusMeta: Record<string, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "neutral" },
  created: { label: "已创建", tone: "neutral" },
  uploading: { label: "上传中", tone: "info" },
  running: { label: "处理中", tone: "info" },
  paused: { label: "已暂停", tone: "warning" },
  needs_review: { label: "待人工审核", tone: "warning" },
  review_pending: { label: "待人工审核", tone: "warning" },
  succeeded: { label: "处理完成", tone: "success" },
  published: { label: "已发布", tone: "success" },
  approved: { label: "已审核待发布", tone: "success" },
  needs_changes: { label: "退回修改", tone: "warning" },
  rejected: { label: "已拒绝", tone: "danger" },
  failed: { label: "处理失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
  cancelling: { label: "取消中", tone: "warning" },
  draft: { label: "草稿", tone: "neutral" },
  archived: { label: "已归档", tone: "neutral" },
};

export function StatusBadge({ status, label }: { status: StatusValue; label?: string }) {
  const meta = (status && statusMeta[status]) || { label: label || status || "未知", tone: "neutral" };
  return <span className={`status-badge status-${meta.tone}`} role="status">{label || meta.label}</span>;
}

export function RoleBadge({ role }: { role?: string | null }) {
  const labels: Record<string, string> = { admin: "管理员", reviewer: "审核员", viewer: "只读" };
  return <span className="role-badge">{role ? labels[role] || role : "未登录"}</span>;
}

export function LoadingBlock({ label = "正在加载…" }: { label?: string }) {
  return <div className="loading-block" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-card state-error" role="alert">
      <div className="state-icon" aria-hidden="true">!</div>
      <div><h3>暂时无法加载</h3><p>{message}</p>{onRetry && <button className="button button-secondary" type="button" onClick={onRetry}>重新尝试</button>}</div>
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="state-card state-empty"><div className="state-icon" aria-hidden="true">∅</div><div><h3>{title}</h3>{description && <p>{description}</p>}{action}</div></div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "danger" | "success"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

export function ProgressBar({ value, label, indeterminate = false }: { value?: number; label?: string; indeterminate?: boolean }) {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(value) ? Number(value) : 0));
  return <div className="progress-wrap"><div className="progress-track" aria-label={label || "进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : normalized} role="progressbar"><div className={`progress-fill${indeterminate ? " progress-indeterminate" : ""}`} style={indeterminate ? undefined : { width: `${normalized}%` }} /></div>{label && <span className="progress-label">{label}</span>}</div>;
}

export function MetricCard({ label, value, detail, tone = "blue" }: { label: string; value: string | number; detail?: string; tone?: "blue" | "green" | "amber" | "red" }) {
  return <article className={`metric-card metric-${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong>{detail && <span className="metric-detail">{detail}</span>}</article>;
}

export function SectionHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="section-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="section-description">{description}</p>}</div>{actions && <div className="section-actions">{actions}</div>}</div>;
}

export function FieldError({ children }: { children?: ReactNode }) {
  return children ? <p className="field-error" role="alert">{children}</p> : null;
}
