# 佳旺美容美发商品录入系统实施计划

## 2026-08-16 deployed increment

- Resource level: heavy.
- Completed and deployed optional review opinions with return/delete, review image recovery, and bulk color variant generation.
- Deployment followed preview approval, isolated candidate smoke tests, database/media/source/image backups, idempotent migration, ordered container replacement, data-count reconciliation, public authenticated browser acceptance and rollback retention.

资源等级：重型（L）  
当前里程碑：M7 仓库媒体修复与多模型配置档案

## M7 当前实施

- 修复 `/warehouse/review` 媒体 URL 未添加 basePath 导致主图和缩略图请求进入订单系统的问题。
- 将单套 DeepSeek 配置升级为管理员专用的 DeepSeek、OpenAI、自定义兼容接口多档案管理；密钥继续加密且不回显。
- 配置修改形成不可变版本，激活只影响新任务；任务创建时固定加密配置快照，暂停、恢复、重试和 Worker 重启不得漂移。
- 完成独立审查和验收后，与订单登录页新头像背景一起生成镜像并联合部署。

## 固定架构与范围

内网单租户 Web；Next.js App Router + React + TypeScript + Tailwind；web、持久化 worker、HTTPS 反向代理分离；SQLite WAL/外键/迁移锁；生产数据库和媒体只使用 Docker/WSL2 Linux named volume。支持 JPG、PNG、WebP，条码 EAN-13、UPC-A、Code128，单 ZIP 默认 4 GiB、展开 12 GiB、10,000 条目、单图 50 MiB/40MP。

角色固定为 admin、reviewer、viewer。AI 只写 suggestion/evidence，商品必须人工审核后才能 published 或默认导出。原图长期保留，发送给云端的仅是去 EXIF/GPS 的派生压缩图。备份为管理员手动生成的加密完整 `.jwbackup`，恢复前自动留底并原子回滚。

## 里程碑与当前结果

- M0 基线/契约：PASS（工程、状态文件、环境模板、API/数据库迁移）。
- M1 平台/登录/RBAC/审计/Compose：PASS（离线测试；目标 Docker 运行未执行）。
- M2 ZIP/图片/任务租约：PASS（安全夹具和重启/幂等测试；大规模压测未执行）。
- M3 AI/分类/分组/OCR/token/SSE：PASS（mock/合同测试；真实 DeepSeek `NOT RUN`）。
- M4 人工审核/商品库/导出：PASS（发布门槛、revision、CSV BOM/公式转义；浏览器 E2E 未执行）。
- M5 加密备份/恢复/运维硬化：PASS（离线 manifest/加密/journal 测试；真实灾备演练 `NOT RUN`）。
- M6 独立审查/验收：进行中；必须逐项输出 PASS/FAIL/BLOCKED/NOT RUN，并在关键项全部 PASS 前不得宣称生产发布。

## 公共控制接口

认证：`/api/v1/auth/login|logout|me|password`；上传：`/api/v1/uploads` 及分块/complete；任务：`/api/v1/import-jobs/:id`、`/events`、`/cancel`、`/pause`、`/resume`、`/retry`；审核/分组：`/api/v1/reviews`、`/review/items`、`/groups`；商品/分类：`/api/v1/catalog/*`、`/taxonomy`；导出：`/exports`；AI 设置/探测：`/admin/config`、`/ai/probe`；备份恢复：`/admin/backups`、`/admin/backups/restore`、`/admin/maintenance`。

所有状态变更需 same-origin、CSRF、JSON Content-Type（上传二进制接口除外）、RBAC、请求 ID和审计；SSE 事件有单调 seq/id，断线使用 `Last-Event-ID` 并轮询兜底。

## 验收门槛

必须运行单元/集成、AI 合同、API/RBAC/CSRF/IDOR、安全、故障注入、导出公式、备份篡改和浏览器 E2E。当前离线证据：typecheck、lint、build、平台/config smoke、30 PASS/0 FAIL/2 SKIP 测试。真实端点、Node 20 native SQLite、Docker named volume、HTTPS、压测、金集质量和灾备演练在环境/资料未提供前记为 `NOT RUN` 或 `BLOCKED`。

## 协作与停止规则

实现代理、reviewer、acceptance 文件所有权不得重叠；实现者不承担唯一审查/验收。遇到同一环境错误只做一次安全诊断和一次低风险重试，仍无新证据就保存状态并报告 BLOCKED，不循环重试。
