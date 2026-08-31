"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import { ArrowLeft, ArrowRight, Eye, EyeOff, KeyRound, MessageSquareText, Phone, RotateCcw } from "lucide-react";

type Mode = "sms" | "password" | "reset";

export default function BuyerLoginPage() {
  const [mode, setMode] = useState<Mode>("sms");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [devCode, setDevCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const destination = () => {
    const target = new URLSearchParams(window.location.search).get("returnTo");
    return target?.startsWith("/") && !target.startsWith("//") && !target.includes("\\") ? target : "/buyer";
  };
  const clear = () => { setCode(""); setChallengeId(""); setDevCode(""); setPassword(""); setConfirmPassword(""); setError(""); setNotice(""); setCountdown(0); };
  const switchMode = (next: Mode) => { clear(); setMode(next); };

  const sendCode = async (purpose: "buyer_access" | "password_reset") => {
    setError(""); setNotice(""); setLoading(true);
    const response = await fetch("/api/auth/buyer/send-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, purpose }) });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) { setError(body.error || "验证码发送失败"); return false; }
    setChallengeId(body.challengeId); setDevCode(body.developmentCode || ""); setCountdown(60); setNotice("验证码已发送，5 分钟内有效。"); return true;
  };

  const smsLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!challengeId) { await sendCode("buyer_access"); return; }
    setError(""); setLoading(true);
    const response = await fetch("/api/auth/buyer/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code, challengeId }) });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) return setError(body.error || "验证失败");
    window.location.assign(destination());
  };

  const passwordLogin = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setLoading(true);
    const response = await fetch("/api/auth/buyer/password-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, password }) });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) return setError(body.error || "登录失败");
    window.location.assign(destination());
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!challengeId) { await sendCode("password_reset"); return; }
    setError(""); setLoading(true);
    const response = await fetch("/api/auth/buyer/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code, challengeId, password, confirmPassword }) });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) return setError(body.error || "密码设置失败");
    clear(); setMode("password"); setNotice("密码已设置，请使用密码登录。");
  };

  return <main className="mobile-safe-screen bg-[#edf1f6] px-0 py-0 sm:px-5 sm:py-8 lg:flex lg:items-center lg:justify-center">
    <section className="mx-auto grid min-h-[100dvh] w-full max-w-[1480px] overflow-hidden bg-white shadow-2xl shadow-slate-900/10 sm:min-h-0 sm:rounded-lg lg:grid-cols-[minmax(0,1.75fr)_minmax(380px,0.75fr)]">
      <div className="flex items-center bg-[#f2f5f9] p-3 sm:p-5 lg:p-7">
        <Image src="/brand/buyer-login-background-portrait.png?v=20260816" alt="佳旺美容美发用品店，诚信经营30年" width={1674} height={941} priority unoptimized className="h-auto w-full rounded-lg object-contain shadow-lg shadow-slate-900/10"/>
      </div>
      <div className="flex min-w-0 flex-col justify-center bg-white">
        <div className="border-b border-slate-100 px-7 py-6"><h1 className="text-xl font-bold text-slate-950">佳旺美容美发用品店</h1><p className="mt-2 text-sm leading-6 text-slate-500">客户登录</p></div>
      {mode === "sms" && <form onSubmit={smsLogin} className="space-y-5 p-7"><h2 className="text-lg font-bold text-slate-900">手机号验证码登录</h2><PhoneField phone={phone} setPhone={setPhone} disabled={!!challengeId}/>{challengeId && <CodeField code={code} setCode={setCode}/>}<DevelopmentCode code={devCode}/><Messages error={error} notice={notice}/><button disabled={loading} className="primary-button">{loading ? "请稍候..." : challengeId ? "验证并进入商城" : "获取验证码"}<ArrowRight size={18}/></button>{challengeId && <div className="flex justify-between text-sm"><button type="button" disabled={countdown>0||loading} onClick={() => sendCode("buyer_access")} className="text-orange-600 disabled:text-slate-400">{countdown>0?`${countdown} 秒后重发`:"重新发送"}</button><button type="button" onClick={() => { setChallengeId(""); setCode(""); setDevCode(""); }} className="text-slate-500">更换手机号</button></div>}<button type="button" onClick={() => switchMode("password")} className="w-full text-sm text-slate-500 hover:text-orange-600">已有密码？使用密码登录</button></form>}
      {mode === "password" && <form onSubmit={passwordLogin} className="space-y-5 p-7"><Back title="密码登录" onClick={() => switchMode("sms")}/><PhoneField phone={phone} setPhone={setPhone}/><PasswordField label="密码" value={password} onChange={setPassword} autoComplete="current-password"/><Messages error={error} notice={notice}/><button disabled={loading} className="primary-button">{loading?"正在登录...":"密码登录"}<ArrowRight size={18}/></button><button type="button" onClick={() => switchMode("reset")} className="w-full text-sm text-slate-500 hover:text-orange-600">忘记或尚未设置密码？使用短信设置</button></form>}
      {mode === "reset" && <form onSubmit={resetPassword} className="space-y-5 p-7"><Back title="设置或重置密码" onClick={() => switchMode("password")} icon="reset"/><PhoneField phone={phone} setPhone={setPhone} disabled={!!challengeId}/>{challengeId && <><CodeField code={code} setCode={setCode}/><PasswordField label="新密码" value={password} onChange={setPassword} autoComplete="new-password"/><PasswordField label="确认新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password"/></>}<DevelopmentCode code={devCode}/><Messages error={error} notice={notice}/><button disabled={loading} className="primary-button">{loading?"请稍候...":challengeId?"确认设置密码":"发送验证码"}<ArrowRight size={18}/></button>{challengeId&&<button type="button" disabled={countdown>0||loading} onClick={() => sendCode("password_reset")} className="w-full text-sm text-orange-600 disabled:text-slate-400">{countdown>0?`${countdown} 秒后可重发`:"重新发送验证码"}</button>}</form>}
      </div>
    </section>
  </main>;
}

function Back({title,onClick,icon}:{title:string;onClick:()=>void;icon?:"reset"}){return <div className="flex items-center gap-3"><button type="button" onClick={onClick} title="返回" className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 text-slate-600"><ArrowLeft size={18}/></button><div><h2 className="font-bold text-slate-900">{title}</h2><p className="text-xs text-slate-400">{icon?<><RotateCcw className="mr-1 inline" size={12}/>验证手机号后安全设置</>:"仅限已经设置过密码的客户"}</p></div></div>}
function PhoneField({phone,setPhone,disabled=false}:{phone:string;setPhone:(value:string)=>void;disabled?:boolean}){return <label className="block text-sm font-medium text-slate-700">手机号<div className="mt-2 flex items-center rounded-xl border border-slate-200 px-4 focus-within:border-orange-500"><Phone size={18} className="text-slate-400"/><input required inputMode="numeric" autoComplete="tel" value={phone} onChange={event=>setPhone(event.target.value.replace(/\D/g,""))} disabled={disabled} maxLength={11} className="w-full bg-transparent px-3 py-3 outline-none disabled:text-slate-500" placeholder="请输入 11 位手机号"/></div></label>}
function CodeField({code,setCode}:{code:string;setCode:(value:string)=>void}){return <label className="block text-sm font-medium text-slate-700">短信验证码<div className="mt-2 flex items-center rounded-xl border border-slate-200 px-4 focus-within:border-orange-500"><MessageSquareText size={18} className="text-slate-400"/><input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,""))} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="6 位验证码"/></div></label>}
function PasswordField({label,value,onChange,autoComplete}:{label:string;value:string;onChange:(value:string)=>void;autoComplete:string}){const[visible,setVisible]=useState(false);return <label className="block text-sm font-medium text-slate-700">{label}<div className="mt-2 flex items-center rounded-xl border border-slate-200 px-4 focus-within:border-orange-500"><KeyRound size={18} className="text-slate-400"/><input required type={visible?"text":"password"} minLength={10} maxLength={128} autoComplete={autoComplete} value={value} onChange={event=>onChange(event.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="至少 10 位"/><button type="button" onClick={()=>setVisible(v=>!v)} title={visible?"隐藏密码":"显示密码"} className="text-slate-400">{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></label>}
function DevelopmentCode({code}:{code:string}){return code?<p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><b>开发环境测试码：</b>{code}<br/><span className="text-xs">正式环境不会显示测试码。</span></p>:null}
function Messages({error,notice}:{error:string;notice:string}){return <>{notice&&<p className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">{notice}</p>}{error&&<p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}</>}
