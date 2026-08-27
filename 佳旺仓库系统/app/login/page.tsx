"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../components/api-client";
import { ShieldIcon } from "../../components/icon";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/warehouse";

export default function LoginPage() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    const dashboard = `${basePath}/dashboard`;
    apiFetch("/api/v1/auth/order-session", { method: "POST", body: "{}" })
      .then(() => { if (active) window.location.replace(dashboard); })
      .catch(() => {
        if (!active) return;
        setChecking(false);
        window.location.replace(`/admin/login?returnTo=${encodeURIComponent(dashboard)}`);
      });
    return () => { active = false; };
  }, []);

  return <main className="login-page">
    <section className="login-form-panel">
      <div className="login-card">
        <ShieldIcon size={24}/><h2>{checking ? "正在验证老板账号" : "正在前往统一登录"}</h2>
        <p>订单后台和仓库系统使用同一个老板账号。</p>
      </div>
    </section>
  </main>;
}
