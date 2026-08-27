# TASK_STATE

## 2026-08-16 returned-product editing deployment

- Resource level: standard.
- Deployed: catalog cards for `needs_changes` products now provide `继续修改`, which opens the existing manual-product workbench in edit mode.
- Edit mode reloads the same product's fields, variants, and ordered controlled assets; saving uses the existing revision-protected `PUT /api/v1/catalog/products/:id` route and preserves the product ID instead of creating a duplicate.
- Verification: local `tsc --noEmit -p tsconfig.json` passed; server production build passed on Next 15.5.23; deployed Web health returned 200; database `quick_check=ok`; no recent fatal Web errors.
- Production scope: only `jiawang-commerce-warehouse-web-1` was recreated. The Worker, order system, database and media volumes were not replaced. Rollback: `/root/jiawang-backups/20260816-returned-edit`, image tag `jiawang-commerce-warehouse-web:before-20260816-returned-edit`, and source directory `/opt/jiawang-commerce-new/warehouse-source-rollback-20260816-returned-edit`.

## 2026-08-16 production checkpoint

- Resource level: heavy.
- Review opinion is optional for return/delete; review media fallback and bulk color variant generation are deployed.
- Active Web image: `sha256:0f3b69e1d10b2c83483ea5a204f7384d781569502522f31214ec298e183036a3`.
- Active Worker image: `sha256:393dfae2d3f0320f6cdc29c8681718dc127d06314fadd486b03d6b8cc77bcf88`.
- Data and media counts match the pre-deploy baseline; database quick check, Web/Worker health, public authenticated browser checks and recent log scan pass.
- Rollback checkpoint: `/root/jiawang-backups/review-loyalty-colors-20260816-v3`.

资源等级：重型（L）  
状态：实施中（M7）  
项目：佳旺美容美发商品录入系统（绿地）

## 当前任务（仓库媒体与多模型配置，2026-08-15）

- 资源等级：重型。
- 恢复清单：父项目 `.task-backups/2026-08-15-warehouse-ai-profiles-before/manifest.txt`。
- 图片根因：审核页直接使用 `/api/v1/media/*`，集成部署下请求进入订单系统；应规范化为 `/warehouse/api/v1/media/*`。
- 模型目标：管理员维护多套 DeepSeek、OpenAI、自定义兼容配置，API Key 用 `APP_MASTER_KEY` 加密；网页激活配置优先，环境变量仅用于初始化/应急恢复。
- 生效约束：配置版本不可变，任务创建时固定版本和加密快照，仅新任务使用新激活配置。
- 部署约束：与父订单系统已确认的新登录背景一起部署；真实付费模型探测必须由管理员显式触发。

## 当前目标

完成一个可在内网部署的 ZIP 商品图片录入系统：分块上传、安全解压、图片派生压缩、可配置 DeepSeek/mock 视觉识别、候选分组、背标字段证据、人工审核发布、商品库查询、Excel/CSV/图片清单导出、实时 SSE/轮询进度、token/费用预算、登录/RBAC、加密备份恢复。

## 已完成里程碑

- M0：Next.js/TypeScript/Tailwind 工程基线、环境模板、契约、Docker Compose、代理和项目状态文件。
- M1：SQLite WAL/迁移锁、Argon2id（Node 原生不可用时参数化 scrypt 兼容路径）、HttpOnly 会话、CSRF/Origin、限流、三角色 RBAC、审计、密码轮换和管理员初始化。
- M2：分块上传、幂等重试、SHA-256 去重、原子文件提交、ZipSlip/UNC/ADS/保留名/符号链接/嵌套压缩/zip bomb/CRC/像素限制、Sharp 派生图去 EXIF。
- M3：持久化 Worker/租约、视角分类和候选商品分组、结构化 AI schema、DeepSeek 能力探测与 SSRF/重定向防护、mock provider、整数 token 预留/结算/未知用量暂停、SSE 回放。
- M4：字段 evidence/revision、人工逐项修改/合并/拆分/审核、发布门槛、商品库和只导出 published 的 CSV/XLSX/图片清单（CSV BOM、公式注入转义）。
- M5：管理员手动加密 `.jwbackup`、manifest/哈希/SQLite 完整性校验、维护模式、写租约、恢复前留底、数据库和媒体 journal、原子切换/回滚、会话撤销、下载流式锁和路径 containment。
- M6 收尾：补齐任务 pause/resume/retry API/UI、导出全量分页和流式下载、独立测试与文档更新正在进行。

## 最近验证证据

已运行并通过：

- `npm.cmd run typecheck`
- `npm.cmd run lint`（仅允许的既有风格提示正在清理）
- `npm.cmd run test:platform`
- `npm.cmd run test:config`
- `npm.cmd test`：30 PASS、0 FAIL、2 SKIP；SKIP 原因是当前主机 Node `v24.18.0` 无法加载 `better-sqlite3` 原生 binding。
- `npm.cmd run build`：Next.js 生产构建成功。
- `docker compose config`：注入临时占位主密钥后通过。

## 必须保持的未运行/阻断项

- `NOT RUN`：真实 DeepSeek Base URL、视觉模型、输入格式、价格和数据处理协议尚未由部署方提供；mock 结果不能替代生产探测。
- `NOT RUN`：Windows Docker Desktop 实际构建/启动、named volume 健康检查和 HTTPS 证书部署；当前 Docker daemon 不可连接。
- `NOT RUN`：真实灾备恢复演练、100/500/2000 图片压测和用户提供的识别金集质量报告。
- `BLOCKED/SKIP`：Node 20 LTS native SQLite 集成测试需在目标 Docker/Node 20 环境运行。

## 安全与交接约束

不得把真实 API key、密码、会话、原图或客户数据写入仓库、日志、状态文件或提交。Live SQLite/媒体只能放 Docker/WSL2 named volume；OneDrive 仅保存源码和管理员下载的备份。恢复 journal、维护锁或下载锁不确定时必须 fail-closed，不能强制清除或创建空数据库。

下一步：完成独立 reviewer/acceptance 逐项报告，修复关键 FAIL，更新 HANDOFF/WORKING_SET/PLANS，并创建首个 Git 安全基线提交。
