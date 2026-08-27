import assert from "node:assert/strict";
const baseUrl=process.env.BASE_URL||"http://127.0.0.1:3000";
const phone=`135${String(Date.now()).slice(-8)}`,password="CustomerPass123!",newPassword="CustomerPass456!";
const testIp=`198.51.100.${Number(String(Date.now()).slice(-2))%200+1}`;
async function request(path,body,cookie="",origin=baseUrl){const headers={"Content-Type":"application/json",Origin:origin,"X-Forwarded-For":testIp};if(cookie)headers.Cookie=cookie;const response=await fetch(`${baseUrl}${path}`,{method:"POST",redirect:"manual",headers,body:JSON.stringify(body)});const text=await response.text();let json={};try{json=JSON.parse(text)}catch{}return{response,json,cookie:response.headers.get("set-cookie")?.split(";")[0]||""};}
async function sendCode(purpose){const result=await request("/api/auth/buyer/send-code",{phone,purpose});assert.equal(result.response.status,200,JSON.stringify(result.json));assert.ok(result.json.developmentCode,"该测试需在开发环境运行");return result.json;}
let result=await request("/api/auth/buyer/password-login",{phone,password});assert.equal(result.response.status,401);
const access=await sendCode("buyer_access");
result=await request("/api/auth/buyer/login",{phone,challengeId:access.challengeId,code:"000000"});assert.equal(result.response.status,401);
result=await request("/api/auth/buyer/login",{phone,challengeId:access.challengeId,code:access.developmentCode});assert.equal(result.response.status,200,JSON.stringify(result.json));const firstCookie=result.cookie;assert.ok(firstCookie);
result=await request("/api/auth/buyer/login",{phone,challengeId:access.challengeId,code:access.developmentCode});assert.equal(result.response.status,401,"验证码只能使用一次");
let me=await fetch(`${baseUrl}/api/auth/me`,{headers:{Cookie:firstCookie}}).then(r=>r.json());assert.equal(me.user.hasPassword,false);
result=await request("/api/auth/buyer/password",{password,confirmPassword:password},firstCookie);assert.equal(result.response.status,200,JSON.stringify(result.json));
me=await fetch(`${baseUrl}/api/auth/me`,{headers:{Cookie:firstCookie}}).then(r=>r.json());assert.equal(me.user.hasPassword,true);
result=await request("/api/auth/buyer/password-login",{phone,password});assert.equal(result.response.status,200);const passwordCookie=result.cookie;assert.ok(passwordCookie);
result=await request("/api/auth/buyer/password",{password:newPassword,confirmPassword:newPassword},firstCookie);assert.equal(result.response.status,401,"已有密码必须短信验证后修改");
const reset=await sendCode("password_reset");result=await request("/api/auth/buyer/login",{phone,challengeId:reset.challengeId,code:reset.developmentCode});assert.equal(result.response.status,401,"密码验证码不能用于登录");
const freshReset=await sendCode("password_reset");result=await request("/api/auth/buyer/password",{password:newPassword,confirmPassword:newPassword,challengeId:freshReset.challengeId,code:freshReset.developmentCode},firstCookie);assert.equal(result.response.status,200,JSON.stringify(result.json));
const oldSession=await fetch(`${baseUrl}/api/auth/me`,{headers:{Cookie:passwordCookie}});assert.equal(oldSession.status,401,"修改密码后其他会话必须退出");
result=await request("/api/auth/buyer/password-login",{phone,password});assert.equal(result.response.status,401);
result=await request("/api/auth/buyer/password-login",{phone,password:newPassword});assert.equal(result.response.status,200);
const existingAccess=await sendCode("buyer_access");result=await request("/api/auth/buyer/login",{phone,challengeId:existingAccess.challengeId,code:existingAccess.developmentCode});assert.equal(result.response.status,200,"已有客户继续验证码登录");
result=await request("/api/auth/buyer/send-code",{phone,purpose:"buyer_access"},"","https://attacker.invalid");assert.equal(result.response.status,403);
console.log("✓ 验证码自动开户、一次性校验、可选密码、密码修改和旧会话撤销通过");
