"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Check, Copy, Download, ExternalLink, QrCode } from "lucide-react";

export default function CustomerEntryClient({ origin }: { origin: string }) {
  const [notice, setNotice] = useState("");
  const loginUrl = `${origin}/customer-entry`;
  const qrUrl = `/api/qr?text=${encodeURIComponent(loginUrl)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setNotice("客户登录链接已复制");
    } catch {
      setNotice("浏览器禁止自动复制，请手动复制下方链接");
    }
  };

  return <main className="min-h-screen bg-[#f4f7fb] px-4 py-6 md:py-10">
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-center justify-between"><div className="flex items-center gap-3"><Link href="/" title="返回商户后台" className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm"><ArrowLeft size={18}/></Link><div><h1 className="text-xl font-semibold text-slate-900">客户登录入口</h1><p className="mt-1 text-xs text-slate-400">下载二维码后，可打印张贴或直接发给客户</p></div></div><Link href="/buyer/login" className="hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 md:flex">预览登录页<ExternalLink size={15}/></Link></header>

      <div className="grid gap-6 lg:grid-cols-[1fr_390px]">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-blue-50 text-blue-600"><QrCode size={22}/></div><div><h2 className="font-semibold text-slate-900">二维码投放说明</h2><p className="mt-1 text-xs text-slate-400">客户扫码后直接进入手机号登录页</p></div></div>
          <div className="mt-7 grid gap-4 sm:grid-cols-2">{[
            ["1", "下载二维码", "点击右侧按钮保存高清 PNG 图片。"],
            ["2", "发给客户", "可通过微信、短信、朋友圈或群聊发送。"],
            ["3", "线下张贴", "打印后放在门店、仓库、报价单或名片上。"],
            ["4", "客户扫码登录", "手机号验证后即可订货，首次使用会自动创建账号。"],
          ].map(item=><div key={item[0]} className="flex gap-3 rounded-2xl bg-slate-50 p-4"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-600 text-xs font-semibold text-white">{item[0]}</span><div><p className="text-sm font-medium text-slate-800">{item[1]}</p><p className="mt-1 text-xs leading-5 text-slate-500">{item[2]}</p></div></div>)}</div>
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800"><strong>正式投放前请注意：</strong>二维码会自动使用当前系统域名。发布到正式域名后，请在正式系统中重新下载一次，避免客户扫到临时预览地址。</div>
          <div className="mt-6"><p className="mb-2 text-xs font-medium text-slate-500">客户登录链接</p><div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 pl-4"><code className="min-w-0 flex-1 truncate text-xs text-slate-600">{loginUrl}</code><button onClick={copyLink} title="复制客户登录链接" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-slate-500 shadow-sm"><Copy size={15}/></button></div></div>
        </section>

        <aside className="rounded-3xl bg-[#112446] p-6 text-white shadow-2xl shadow-blue-950/20"><div className="text-center"><Image src="/brand/portrait.jpg" alt="佳旺美容美发用品店" width={64} height={64} className="mx-auto h-16 w-16 rounded-lg border-2 border-white/30 bg-white object-contain"/><h2 className="mt-3 text-xl font-semibold">佳旺美容美发用品店</h2><p className="mx-auto mt-1 max-w-xs text-sm leading-6 text-blue-200">同城美发店 · 专属批发平台 · 免费送货上门 · 下单即享优惠</p></div>
          <div className="mx-auto mt-6 w-fit rounded-3xl bg-white p-4 shadow-xl"><Image src={qrUrl} alt="客户登录二维码" width={238} height={238} unoptimized priority/></div>
          <p className="mt-5 text-center text-sm font-medium">微信或浏览器扫码进入</p><p className="mt-1 text-center text-xs text-blue-200">首次验证自动创建账号，无需设置密码</p>
          <div className="mt-6 grid grid-cols-2 gap-3"><a href={qrUrl} download="佳旺美容美发用品店-客户登录二维码.png" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-medium hover:bg-blue-400"><Download size={16}/>下载二维码</a><button onClick={copyLink} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white/10 text-sm font-medium hover:bg-white/15"><Copy size={16}/>复制链接</button></div>
          {notice&&<div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-emerald-400/15 px-3 py-2 text-xs text-emerald-200"><Check size={14}/>{notice}</div>}
        </aside>
      </div>
    </div>
  </main>;
}
