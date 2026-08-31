import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import Database from "better-sqlite3";

const baseUrl=process.env.BASE_URL||"http://127.0.0.1:3000",phone=process.env.TEST_OWNER_PHONE,password=process.env.TEST_OWNER_PASSWORD;
if(!phone||!password)throw new Error("请提供 TEST_OWNER_PHONE 和 TEST_OWNER_PASSWORD");
function hashPassword(value){const salt=randomBytes(16).toString("hex"),hash=scryptSync(value,salt,64).toString("hex");return`scrypt$${salt}$${hash}`;}
if(!process.env.BASE_URL){const databaseUrl=process.env.DATABASE_URL||"file:./data/app.db",databasePath=databaseUrl.startsWith("file:")?databaseUrl.slice(5):databaseUrl,testDb=new Database(databasePath),keyHash=createHash("sha256").update(phone).digest("hex");testDb.prepare("DELETE FROM rate_limit_events WHERE bucket='admin-login-account' AND key_hash=?").run(keyHash);testDb.prepare("UPDATE users SET password_hash=? WHERE phone=? AND role='owner'").run(hashPassword(password),phone);testDb.close();}
const testIp=`198.51.100.${Number(String(Date.now()).slice(-2))%200+1}`;
function cookie(response){return response.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");}
async function call(path,{body,cookieValue=""}={}){const headers=new Headers({"Content-Type":"application/json","Origin":baseUrl,"X-Forwarded-For":testIp});if(cookieValue)headers.set("Cookie",cookieValue);const response=await fetch(`${baseUrl}${path}`,{method:"POST",headers,body:JSON.stringify(body||{})});const json=await response.json().catch(()=>({}));return{response,json,cookie:cookie(response)};}
const temporary=`Changed-${Date.now()}-Aa!`;
const login=await call("/api/auth/admin/login",{body:{phone,password}});assert.equal(login.response.status,200,JSON.stringify(login.json));let changed=false;
try{
 const update=await call("/api/auth/admin/change-password",{cookieValue:login.cookie,body:{currentPassword:password,newPassword:temporary,confirmPassword:temporary}});assert.equal(update.response.status,200,JSON.stringify(update.json));changed=true;
 const oldLogin=await call("/api/auth/admin/login",{body:{phone,password}});assert.equal(oldLogin.response.status,401);
 const newLogin=await call("/api/auth/admin/login",{body:{phone,password:temporary}});assert.equal(newLogin.response.status,200,JSON.stringify(newLogin.json));
 const restore=await call("/api/auth/admin/change-password",{cookieValue:newLogin.cookie,body:{currentPassword:temporary,newPassword:password,confirmPassword:password}});assert.equal(restore.response.status,200,JSON.stringify(restore.json));changed=false;
 console.log("✓ 老板可在后台修改初始密码，旧密码失效且当前会话保留");
}finally{
 if(changed&&!process.env.BASE_URL){const databaseUrl=process.env.DATABASE_URL||"file:./data/app.db",databasePath=databaseUrl.startsWith("file:")?databaseUrl.slice(5):databaseUrl,testDb=new Database(databasePath);testDb.prepare("UPDATE users SET password_hash=? WHERE phone=? AND role='owner'").run(hashPassword(password),phone);testDb.close();}
}
