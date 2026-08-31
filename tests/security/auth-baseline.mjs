import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
async function request(path, init = {}) { return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init }); }
const checks = [];
async function check(name, test) { try { await test(); checks.push([name, "PASS"]); } catch (error) { checks.push([name, `FAIL: ${error.message}`]); process.exitCode = 1; } }

await check("默认入口展示客户登录", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /客户登录/);
  assert.match(body, /手机号验证码登录/);
});
await check("后台未登录跳转老板登录页", async () => {
  const response = await request("/admin");
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") || "", /\/admin\/login/);
});
await check("买家未登录跳转登录页", async () => {
  const response = await request("/buyer");
  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") || "", /\/buyer\/login/);
});
await check("未登录禁止改价", async () => {
  const response = await request("/api/orders/price", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
});
await check("未登录禁止导出", async () => { const response = await request("/api/exports/orders"); assert.equal(response.status, 401); });
await check("客户注册与密码登录接口公开但执行同源校验", async () => {
  for (const path of ["/api/auth/buyer/register", "/api/auth/buyer/password-login", "/api/auth/buyer/reset-password"]) {
    const response = await request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid" }, body: "{}" });
    assert.equal(response.status, 403);
  }
});
await check("未登录禁止使用老板专属买家调试入口", async () => {
  const response = await request("/api/auth/buyer/debug-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
});
await check("未登录禁止创建商品", async () => {
  const response = await request("/api/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
});
await check("未登录禁止上传商品图片", async () => {
  const response = await request("/api/products/not-found/images", { method: "POST", body: new FormData() });
  assert.equal(response.status, 401);
});
await check("跨站写请求在认证前即被拒绝", async () => {
  const response = await request("/api/products", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", Origin: "https://attacker.invalid" }, body: "{}" });
  assert.equal(response.status, 403);
});
await check("健康检查最小公开", async () => {
  const response = await request("/api/health"); assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(Object.keys(body).sort(), ["ok"]);
});
for (const [name, result] of checks) console.log(`${result.startsWith("PASS") ? "✓" : "✗"} ${name}: ${result}`);
