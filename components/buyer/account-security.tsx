"use client";

import { FormEvent, useEffect, useState } from "react";
import { KeyRound, MessageSquareText, ShieldCheck } from "lucide-react";

export default function AccountSecurity({ phone, hasPassword, onChanged }: { phone: string; hasPassword: boolean; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  useEffect(() => { if (!countdown) return; const timer = window.setInterval(() => setCountdown(value => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, [countdown]);
  const sendCode = async () => {
    setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/auth/buyer/send-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, purpose: "password_reset" }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) return setError(body.error || "验证码发送失败");
    setChallengeId(body.challengeId); setDevCode(body.developmentCode || ""); setCountdown(60); setMessage("验证码已发送");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const response = await fetch("/api/auth/buyer/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, confirmPassword, code, challengeId }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) return setError(body.error || "密码设置失败");
    setPassword(""); setConfirmPassword(""); setCode(""); setChallengeId(""); setDevCode(""); setOpen(false); setMessage(hasPassword ? "密码已修改，其他设备已退出登录" : "登录密码已设置"); await onChanged();
  };
  return <section className="rounded-2xl bg-white p-5 shadow-sm"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><ShieldCheck size={19}/></div><div><h3 className="font-semibold text-slate-900">账号安全</h3><p className="mt-1 text-xs leading-5 text-slate-500">{hasPassword ? "已设置密码，也可继续使用验证码登录" : "当前使用验证码登录，密码为可选项"}</p></div></div><button onClick={()=>{setOpen(value=>!value);setError("");setMessage("")}} className="shrink-0 text-sm font-medium text-orange-600">{open?"收起":hasPassword?"修改密码":"设置密码"}</button></div>{message&&!open&&<p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{message}</p>}{open&&<form onSubmit={submit} className="mt-5 space-y-4 border-t border-slate-100 pt-5">{hasPassword&&!challengeId&&<button type="button" disabled={busy} onClick={sendCode} className="flex w-full items-center justify-center gap-2 rounded-xl border border-orange-200 py-3 text-sm font-semibold text-orange-600"><MessageSquareText size={17}/>发送修改验证码</button>}{hasPassword&&challengeId&&<label className="block text-sm text-slate-700">短信验证码<input required inputMode="numeric" maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,""))} className="input mt-2" placeholder="6 位验证码"/></label>}{(!hasPassword||challengeId)&&<><PasswordInput label="新密码" value={password} setValue={setPassword}/><PasswordInput label="确认新密码" value={confirmPassword} setValue={setConfirmPassword}/>{devCode&&<p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">开发环境测试码：{devCode}</p>}<button disabled={busy} className="primary-button">{busy?"正在保存...":hasPassword?"确认修改密码":"设置登录密码"}</button></>}{hasPassword&&challengeId&&<button type="button" disabled={busy||countdown>0} onClick={sendCode} className="w-full text-xs text-orange-600 disabled:text-slate-400">{countdown?`${countdown} 秒后可重发`:"重新发送验证码"}</button>}{error&&<p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}{message&&<p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">{message}</p>}</form>}</section>;
}

function PasswordInput({label,value,setValue}:{label:string;value:string;setValue:(value:string)=>void}){return <label className="block text-sm text-slate-700">{label}<div className="mt-2 flex items-center rounded-xl border border-slate-200 px-3"><KeyRound size={16} className="text-slate-400"/><input required type="password" minLength={10} maxLength={128} value={value} onChange={event=>setValue(event.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="至少 10 位"/></div></label>}
