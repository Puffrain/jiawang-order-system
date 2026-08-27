"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import { ArrowLeft, LockKeyhole, MessageSquareText, Phone } from "lucide-react";

export default function AdminLoginPage() {
  const [phone, setPhone] = useState("13806265100");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [developmentCode, setDevelopmentCode] = useState("");
  const [resetMode, setResetMode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage(""); setLoading(true);
    const response = await fetch("/api/auth/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }) });
    const result = await response.json().catch(() => ({}));
    setLoading(false);
    if (!response.ok) return setError(result.error || "登录失败，请稍后重试");
    const target = new URLSearchParams(window.location.search).get("returnTo");
    const safeTarget = target && !target.startsWith("//") && (target.startsWith("/admin") || target === "/warehouse" || target.startsWith("/warehouse/"));
    window.location.assign(safeTarget ? target : "/admin");
  };

  const sendCode = async () => {
    setError(""); setMessage(""); setLoading(true);
    const response = await fetch("/api/auth/admin/send-reset-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
    const result = await response.json().catch(() => ({}));
    setLoading(false);
    if (!response.ok) return setError(result.error || "验证码发送失败");
    setChallengeId(result.challengeId); setDevelopmentCode(result.developmentCode || ""); setCountdown(60); setMessage("验证码已发送");
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage(""); setLoading(true);
    const response = await fetch("/api/auth/admin/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, challengeId, code, password, confirmPassword }) });
    const result = await response.json().catch(() => ({}));
    setLoading(false);
    if (!response.ok) return setError(result.error || "密码重置失败");
    setResetMode(false); setChallengeId(""); setCode(""); setConfirmPassword(""); setDevelopmentCode(""); setMessage("密码已重置，请使用新密码登录");
  };

  const leaveReset = () => { setResetMode(false); setChallengeId(""); setCode(""); setConfirmPassword(""); setDevelopmentCode(""); setError(""); setMessage(""); };

  return <main className="mobile-safe-screen safe-top flex items-center justify-center bg-slate-950 px-4 py-6 sm:px-5 sm:py-12">
    <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl shadow-black/30 sm:rounded-3xl sm:p-8">
      <Image src="/brand/portrait.jpg" alt="佳旺美容美发用品店" width={112} height={112} priority className="mb-7 h-28 w-28 rounded-lg border-2 border-orange-100 bg-white object-contain"/>
      <p className="text-sm font-semibold leading-6 text-orange-600">同城美发店 · 专属批发平台 · 免费送货上门 · 下单即享优惠</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-950">{resetMode ? "找回老板密码" : "老板登录"}</h1>
      {resetMode ? <form onSubmit={resetPassword} className="mt-8 space-y-5">
        <Field icon={<Phone size={18}/>} label="手机号"><input required inputMode="numeric" autoComplete="username" value={phone} onChange={e=>setPhone(e.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="请输入老板手机号"/></Field>
        {!challengeId ? <button type="button" disabled={loading} onClick={sendCode} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-orange-200 font-semibold text-orange-600 disabled:opacity-60"><MessageSquareText size={18}/>{loading ? "正在发送..." : "发送短信验证码"}</button> : <>
          <Field icon={<MessageSquareText size={18}/>} label="短信验证码"><input required inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g, ""))} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="请输入 6 位验证码"/></Field>
          <Field icon={<LockKeyhole size={18}/>} label="新密码"><input required type="password" minLength={10} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="至少 10 位"/></Field>
          <Field icon={<LockKeyhole size={18}/>} label="确认新密码"><input required type="password" minLength={10} autoComplete="new-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="再次输入新密码"/></Field>
          {developmentCode && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">开发环境测试码：{developmentCode}</p>}
          <button disabled={loading} className="min-h-11 w-full rounded-xl bg-orange-500 font-semibold text-white disabled:opacity-60">{loading ? "正在重置..." : "确认重置密码"}</button>
          <button type="button" disabled={loading || countdown > 0} onClick={sendCode} className="min-h-11 w-full text-sm text-orange-600 disabled:text-slate-400">{countdown ? `${countdown} 秒后可重发` : "重新发送验证码"}</button>
        </>}
        {message && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <button type="button" onClick={leaveReset} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm font-medium text-slate-600"><ArrowLeft size={17}/>返回密码登录</button>
      </form> : <form onSubmit={submit} className="mt-8 space-y-5">
        <Field icon={<Phone size={18}/>} label="手机号"><input required inputMode="numeric" autoComplete="username" value={phone} onChange={e=>setPhone(e.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="请输入老板手机号"/></Field>
        <Field icon={<LockKeyhole size={18}/>} label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="请输入密码"/></Field>
        <div className="flex justify-end"><button type="button" onClick={()=>{setResetMode(true);setError("");setMessage("");}} className="min-h-11 px-1 text-sm font-medium text-orange-600">忘记密码？</button></div>
        {message && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <button disabled={loading} className="min-h-12 w-full rounded-xl bg-orange-500 font-semibold text-white shadow-lg shadow-orange-500/20 hover:bg-orange-600 disabled:opacity-60">{loading ? "正在验证..." : "安全登录"}</button>
      </form>}
    </section>
  </main>;
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<div className="mt-2 flex min-h-12 items-center rounded-xl border border-slate-200 px-4 text-slate-400 focus-within:border-orange-500">{icon}{children}</div></label>;
}
