import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL;
if (!baseUrl) throw new Error("请通过 BASE_URL 提供待检查的正式站点地址");
const routes = ["/", "/admin", "/admin/login", "/api/health"];
const report = [];

for (const path of routes) {
  let current = new URL(path, baseUrl);
  const chain = [];
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(current, { redirect: "manual", headers: { "Cache-Control": "no-cache" } });
    const item = { url: current.toString(), status: response.status, location: response.headers.get("location"), contentType: response.headers.get("content-type") || "" };
    chain.push(item);
    if (response.status >= 300 && response.status < 400) {
      assert.ok(item.location, `${path} 返回跳转但没有 Location`);
      current = new URL(item.location, current);
      continue;
    }
    assert.equal(response.status, 200, `${path} 访问失败：${JSON.stringify(chain)}`);
    const body = await response.text();
    if (path === "/") assert.match(body, /欢迎来到批发商城/, "首页不是客户商城入口");
    if (path === "/admin" || path === "/admin/login") assert.match(body, /老板登录/, "后台未进入老板登录页");
    if (path === "/api/health") assert.deepEqual(JSON.parse(body), { ok: true });
    if (item.contentType.includes("text/html")) {
      const assets = [...body.matchAll(/(?:src|href)="([^"?]*\/_next\/static\/[^"?]+)(?:\?[^"}]*)?"/g)].map(match => new URL(match[1], current));
      for (const assetUrl of new Set(assets.map(asset => asset.toString()))) {
        const asset = await fetch(assetUrl, { cache: "no-store" });
        assert.ok(asset.ok, `${path} 引用了不可用资源 ${assetUrl} (${asset.status})`);
      }
    }
    break;
  }
  report.push({ path, chain });
}

const loginProbe = await fetch(new URL("/api/auth/admin/login", baseUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: new URL(baseUrl).origin },
  body: JSON.stringify({ phone: process.env.OWNER_PHONE || "13806265100", password: "configuration-probe-only" }),
});
const loginBody = await loginProbe.json().catch(() => ({}));
const ownerConfigured = !(loginProbe.status === 503 && String(loginBody.error || "").includes("尚未初始化"));
console.log(JSON.stringify({ baseUrl, routes: report, ownerConfigured, loginProbe: { status: loginProbe.status, message: loginBody.error || null } }, null, 2));
if (!ownerConfigured) process.exitCode = 2;
