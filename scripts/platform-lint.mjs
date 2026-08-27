#!/usr/bin/env node
// 平台结构检查: eslint 管不到的"失败场景". 报错信息 = 为什么 + 怎么改.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const errors = [];

// 1. 客户端错误自动上报三件套: 平台靠它把浏览器错误喂回 AI 自愈, 删了用户
//    就得自己贴报错截图. 缺失时必须还原文件并保持 layout.tsx 挂载.
for (const f of ["lib/error-reporter.tsx", "app/api/luffy-platform-error/route.ts"]) {
  if (!existsSync(f)) errors.push(`缺少平台文件 ${f}: error-reporter 三件套负责把浏览器错误自动上报给平台修复, 禁止删除, 请还原该文件`);
}
if (existsSync("app/layout.tsx") && !readFileSync("app/layout.tsx", "utf8").includes("<ErrorReporter")) {
  errors.push("app/layout.tsx 未挂载 <ErrorReporter />: 挂载后浏览器端报错才能自动回传平台, 请在 body 内加回 <ErrorReporter />");
}

// 2. 可变数据必须落 data/: data/ 之外的 SQLite 会被打进构建镜像, 发布时构建
//    阶段对着真库重放迁移, 撞 duplicate column / UNIQUE 冲突.
const hits = execSync(
  String.raw`find . -path ./data -prune -o -path ./node_modules -prune -o \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print`,
  { encoding: "utf8" }).trim();
if (hits) errors.push(`数据文件放错位置: ${hits.split("\n").join(", ")}。SQLite/上传文件必须写在 data/ 下, 否则发布构建会撞迁移冲突; 请把文件移入 data/ 并让代码从 data/ 读写`);

if (errors.length) { console.log(errors.map((e) => `[platform-lint] ${e}`).join("\n")); process.exit(1); }
