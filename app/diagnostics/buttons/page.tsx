"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Copy, Download, ExternalLink, MousePointerClick,
  Play, RefreshCw, ShieldAlert, SquareDashedMousePointer,
} from "lucide-react";

type Issue = "disabled" | "pointer-events" | "covered" | "missing-handler" | "invalid-link" | "keyboard";
type ScanRow = {
  index: number;
  label: string;
  selector: string;
  tag: string;
  issues: Issue[];
  visible: boolean;
  hasHandler: boolean;
  pointerEvents: string;
  details: string;
};

const issueLabel: Record<Issue, string> = {
  disabled: "已禁用",
  "pointer-events": "禁止点击",
  covered: "被其他元素遮挡",
  "missing-handler": "疑似缺少点击事件",
  "invalid-link": "链接地址无效",
  keyboard: "缺少键盘支持",
};

export default function ButtonDiagnosticsPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [target, setTarget] = useState("/buyer/login");
  const [activeSrc, setActiveSrc] = useState("/buyer/login");
  const [reloadKey, setReloadKey] = useState(0);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [status, setStatus] = useState("等待页面加载");
  const [filter, setFilter] = useState<"all" | "problem" | Issue>("problem");
  const [notice, setNotice] = useState("");

  const scan = () => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!doc) { setStatus("无法读取页面，请确认目标是同域地址"); return; }
    const selector = "button, a, [role='button'], input[type='button'], input[type='submit'], input[type='reset'], summary, [onclick], [tabindex]";
    const elements = Array.from(doc.querySelectorAll<HTMLElement>(selector));
    const nextRows = elements.map((element, index) => inspectElement(element, index, doc)).filter(row => row.visible);
    setRows(nextRows);
    setStatus(`已扫描 ${nextRows.length} 个可见交互元素`);
  };

  const runTarget = () => {
    const safeTarget = target.startsWith("/") ? target : `/${target}`;
    setRows([]);
    setStatus("正在加载目标页面…");
    setActiveSrc(safeTarget);
    setReloadKey(value => value + 1);
  };

  const filtered = rows.filter(row => filter === "all" ? true : filter === "problem" ? row.issues.length > 0 : row.issues.includes(filter));
  const issueCount = rows.filter(row => row.issues.length > 0).length;
  const severeCount = rows.filter(row => row.issues.some(issue => ["disabled","pointer-events","covered","invalid-link"].includes(issue))).length;

  const reportText = [
    "按钮可交互性检测报告",
    `目标页面：${activeSrc}`,
    `扫描数量：${rows.length}，问题元素：${issueCount}，严重问题：${severeCount}`,
    "",
    ...rows.filter(row=>row.issues.length).map(row=>`#${row.index + 1} ${row.label} | ${row.selector} | ${row.issues.map(issue=>issueLabel[issue]).join("、")} | ${row.details}`),
  ].join("\n");
  const reportHref = `data:text/plain;charset=utf-8,${encodeURIComponent(reportText)}`;

  const copyReport = async () => {
    try { await navigator.clipboard.writeText(reportText); setNotice("检测报告已复制"); }
    catch { setNotice("浏览器禁止复制，请使用下载报告"); }
  };
  return <main className="min-h-screen bg-[#f4f7fb] text-slate-800">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-4 backdrop-blur md:px-7"><div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4"><div className="flex items-center gap-3"><Link href="/" title="返回商户后台" className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 text-slate-600"><ArrowLeft size={18}/></Link><div><h1 className="font-semibold text-slate-900">按钮可交互性诊断台</h1><p className="mt-0.5 text-xs text-slate-400">扫描禁用、点击穿透、元素遮挡、无效链接与疑似缺少事件</p></div></div><div className="hidden items-center gap-2 sm:flex"><button onClick={copyReport} disabled={!rows.length} className="flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs text-slate-600 disabled:opacity-40"><Copy size={14}/>复制报告</button><a href={rows.length?reportHref:undefined} download="按钮可交互性检测报告.txt" aria-disabled={!rows.length} className="flex h-9 items-center gap-2 rounded-xl bg-slate-900 px-3 text-xs font-medium text-white aria-disabled:pointer-events-none aria-disabled:opacity-40"><Download size={14}/>下载报告</a></div></div></header>

    <div className="mx-auto grid max-w-[1500px] gap-5 p-4 md:p-6 xl:grid-cols-[420px_1fr]">
      <aside className="space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><SquareDashedMousePointer size={18} className="text-blue-600"/><h2 className="font-semibold">选择检测页面</h2></div><div className="mt-4 flex gap-2"><input value={target} onChange={event=>setTarget(event.target.value)} onKeyDown={event=>event.key==="Enter"&&runTarget()} placeholder="例如 /buyer/login" className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"/><button onClick={runTarget} title="加载并检测" className="grid h-11 w-11 place-items-center rounded-xl bg-blue-600 text-white"><Play size={17}/></button></div><div className="mt-3 flex flex-wrap gap-2">{[["客户登录","/buyer/login"],["买家商城","/buyer"],["商户后台","/"]].map(item=><button key={item[1]} onClick={()=>{setTarget(item[1]);setActiveSrc(item[1]);setReloadKey(value=>value+1);setStatus("正在加载目标页面…")}} className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700">{item[0]}</button>)}</div><p className="mt-4 text-xs leading-5 text-slate-400">仅支持检测当前系统内的页面；外部网站受浏览器安全限制无法读取。</p></section>

        <section className="grid grid-cols-3 gap-3">{[
          {label:"可见元素",value:rows.length,color:"text-slate-900",icon:MousePointerClick},
          {label:"发现问题",value:issueCount,color:"text-amber-600",icon:AlertTriangle},
          {label:"严重问题",value:severeCount,color:"text-rose-600",icon:ShieldAlert},
        ].map(card=>{const Icon=card.icon;return <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><Icon size={17} className={card.color}/><p className={`mt-3 text-2xl font-semibold ${card.color}`}>{card.value}</p><p className="mt-1 text-[10px] text-slate-400">{card.label}</p></div>})}</section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-100 p-4"><div><h2 className="text-sm font-semibold">检测结果</h2><p className="mt-1 text-[10px] text-slate-400">{status}</p></div><button onClick={scan} title="重新扫描" className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50 text-blue-600"><RefreshCw size={15}/></button></div><div className="flex gap-1 overflow-x-auto border-b border-slate-100 p-2">{[["problem","有问题"],["all","全部"],["disabled","禁用"],["pointer-events","穿透"],["covered","遮挡"]].map(item=><button key={item[0]} onClick={()=>setFilter(item[0] as typeof filter)} className={`shrink-0 rounded-lg px-3 py-1.5 text-[11px] ${filter===item[0]?"bg-slate-900 text-white":"text-slate-500 hover:bg-slate-50"}`}>{item[1]}</button>)}</div><div className="max-h-[520px] overflow-y-auto">{filtered.map(row=><div key={`${row.selector}-${row.index}`} className="border-b border-slate-100 p-4 last:border-0"><div className="flex items-start gap-3"><span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${row.issues.length?"bg-amber-50 text-amber-600":"bg-emerald-50 text-emerald-600"}`}>{row.issues.length?<AlertTriangle size={14}/>:<CheckCircle2 size={14}/>}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-800">{row.label}</p><code className="mt-1 block truncate text-[10px] text-slate-400">{row.selector}</code><div className="mt-2 flex flex-wrap gap-1">{row.issues.length?row.issues.map(issue=><span key={issue} className={`rounded px-2 py-1 text-[9px] ${["pointer-events","covered","invalid-link"].includes(issue)?"bg-rose-50 text-rose-600":"bg-amber-50 text-amber-700"}`}>{issueLabel[issue]}</span>):<span className="rounded bg-emerald-50 px-2 py-1 text-[9px] text-emerald-700">基础检查通过</span>}</div>{row.details&&<p className="mt-2 text-[10px] leading-4 text-slate-500">{row.details}</p>}</div></div></div>)}{!filtered.length&&<div className="p-10 text-center"><CheckCircle2 size={30} className="mx-auto text-emerald-400"/><p className="mt-3 text-sm text-slate-500">当前筛选下没有问题</p></div>}</div></section>

        <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-xs leading-5 text-blue-800"><strong>检测说明：</strong>系统会读取 React 节点上的事件信号，但“疑似缺少事件”仍建议人工点击确认；诊断台不会自动点击登录、加购或提交订单，避免误操作。</section>
      </aside>

      <section className="min-h-[780px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex h-12 items-center justify-between border-b border-slate-200 bg-slate-50 px-4"><div className="flex items-center gap-2 text-xs text-slate-500"><span className="h-2.5 w-2.5 rounded-full bg-rose-400"/><span className="h-2.5 w-2.5 rounded-full bg-amber-400"/><span className="h-2.5 w-2.5 rounded-full bg-emerald-400"/><code className="ml-2">{activeSrc}</code></div><a href={activeSrc} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-600">新窗口打开<ExternalLink size={13}/></a></div><iframe key={reloadKey} ref={iframeRef} src={activeSrc} title="待检测页面" onLoad={()=>{setStatus("页面已加载，正在扫描…");window.setTimeout(scan,300)}} className="h-[calc(100vh-130px)] min-h-[730px] w-full bg-white"/></section>
    </div>
    {notice&&<div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl"><CheckCircle2 size={15} className="text-emerald-400"/>{notice}</div>}
  </main>;
}

function inspectElement(element: HTMLElement, index: number, doc: Document): ScanRow {
  const style = doc.defaultView?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const visible = Boolean(style && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0);
  const issues: Issue[] = [];
  const disabled = element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
  if (disabled) issues.push("disabled");
  if (style?.pointerEvents === "none") issues.push("pointer-events");

  const centerX = Math.min(doc.documentElement.clientWidth - 1, Math.max(0, rect.left + rect.width / 2));
  const centerY = Math.min(doc.documentElement.clientHeight - 1, Math.max(0, rect.top + rect.height / 2));
  const topElement = doc.elementFromPoint(centerX, centerY);
  if (visible && topElement && topElement !== element && !element.contains(topElement) && !topElement.contains(element)) issues.push("covered");

  const reactPropsKey = Object.keys(element).find(key => key.startsWith("__reactProps$") || key.startsWith("__reactEventHandlers$"));
  const reactProps = reactPropsKey ? (element as unknown as Record<string, unknown>)[reactPropsKey] as Record<string, unknown> | undefined : undefined;
  const hasHandler = typeof element.onclick === "function" || typeof reactProps?.onClick === "function" || element.hasAttribute("onclick") || (element instanceof HTMLAnchorElement && Boolean(element.getAttribute("href"))) || (element instanceof HTMLButtonElement && element.type === "submit" && Boolean(element.form));
  if (!disabled && !hasHandler) issues.push("missing-handler");

  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute("href");
    if (!href || href === "#" || href.startsWith("javascript:")) issues.push("invalid-link");
  }
  if (element.getAttribute("role") === "button" && element.tabIndex < 0) issues.push("keyboard");

  const label = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || element.getAttribute("value") || `${element.tagName} 元素`).replace(/\s+/g," ").trim().slice(0,80);
  const selector = buildSelector(element);
  const details = [
    disabled ? "元素当前处于 disabled / aria-disabled 状态。" : "",
    style?.pointerEvents === "none" ? "CSS pointer-events 为 none，鼠标和触摸事件不会到达该元素。" : "",
    issues.includes("covered") ? `元素中心点被 ${topElement?.tagName.toLowerCase()} 覆盖。` : "",
    issues.includes("missing-handler") ? "未发现原生 onclick、React onClick、有效链接或表单提交信号。" : "",
  ].filter(Boolean).join(" ");

  return { index, label, selector, tag: element.tagName.toLowerCase(), issues, visible, hasHandler, pointerEvents: style?.pointerEvents || "unknown", details };
}

function buildSelector(element: HTMLElement) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId}"]`;
  const role = element.getAttribute("role");
  const label = element.getAttribute("aria-label");
  if (role && label) return `[role="${role}"][aria-label="${label}"]`;
  const classes = Array.from(element.classList).slice(0,2).map(item=>`.${CSS.escape(item)}`).join("");
  return `${element.tagName.toLowerCase()}${classes}`;
}
