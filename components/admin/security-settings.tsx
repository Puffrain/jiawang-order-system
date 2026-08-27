"use client";

import { FormEvent, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

export default function SecuritySettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setNotice(""); setLoading(true);
    const response = await fetch("/api/auth/admin/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
    const body = await response.json().catch(() => ({})); setLoading(false);
    if (!response.ok) return setError(body.error || "密码修改失败");
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setNotice("密码修改成功，其他设备上的老板登录已退出。");
  };
  return <div className="max-w-xl"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><ShieldCheck size={21}/></div><div><h2 className="text-xl font-bold">账号安全</h2><p className="mt-1 text-sm text-slate-500">首次登录后请立即修改临时密码。</p></div></div><form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-slate-200 p-5"><PasswordField label="当前密码" value={currentPassword} setValue={setCurrentPassword}/><PasswordField label="新密码" value={newPassword} setValue={setNewPassword}/><PasswordField label="确认新密码" value={confirmPassword} setValue={setConfirmPassword}/>{error&&<p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}{notice&&<p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}<button disabled={loading} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60">{loading?"正在修改…":"修改老板密码"}</button></form></div>;
}

function PasswordField({label,value,setValue}:{label:string;value:string;setValue:(value:string)=>void}){return <label className="block text-sm font-medium text-slate-700">{label}<div className="mt-2 flex items-center rounded-xl border border-slate-200 px-4 focus-within:border-orange-500"><KeyRound size={17} className="text-slate-400"/><input required minLength={10} maxLength={128} type="password" autoComplete={label==="当前密码"?"current-password":"new-password"} value={value} onChange={event=>setValue(event.target.value)} className="w-full bg-transparent px-3 py-3 outline-none" placeholder="至少 10 位，建议混合字母、数字和符号"/></div></label>}
