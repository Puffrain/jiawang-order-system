import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { ArrowLeft, Download, FileText } from "lucide-react";

export default function SetupGuidePage() {
  const filePath = path.join(process.cwd(), "docs", "上线前需提供资料清单.md");
  const markdown = fs.readFileSync(filePath, "utf8");

  return <main className="min-h-screen bg-[#f4f7fb] px-4 py-6 md:py-10"><div className="mx-auto max-w-5xl"><header className="mb-6 flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-center"><div className="flex items-center gap-3"><Link href="/" title="返回商户后台" className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600"><ArrowLeft size={18}/></Link><div><h1 className="text-xl font-semibold text-slate-900">上线前资料清单</h1><p className="mt-1 text-xs text-slate-400">把正式资料准备齐后，登录、支付、物流和数据才能完整跑通</p></div></div><Link href="/api/docs/setup" download className="flex h-10 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white"><Download size={15}/>下载 Markdown</Link></header><section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-5 py-4 text-sm font-medium text-slate-700"><FileText size={16} className="text-blue-600"/>上线前需提供资料清单.md</div><pre className="overflow-x-auto whitespace-pre-wrap break-words p-5 font-sans text-sm leading-7 text-slate-700 md:p-8">{markdown}</pre></section></div></main>;
}
