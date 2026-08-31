# HANDOFF

## 2026-08-16 returned-product editing deployment

- User approved deployment after local preview.
- Deployed only warehouse Web image `sha256:23672db91ef5803e74370571997007f164d841592ebb48fd6978a47a8f2f2e15`; the Worker remained on its previous image and the order system was not changed.
- Production checks passed: `quick_check=ok`, 1 existing `needs_changes` product, Web health `200`, and no fatal Web log entries after restart.
- Rollback: `/root/jiawang-backups/20260816-returned-edit`, Web image tag `jiawang-commerce-warehouse-web:before-20260816-returned-edit`, and source directory `/opt/jiawang-commerce-new/warehouse-source-rollback-20260816-returned-edit`.

## 2026-08-16 review/image/bulk-color deployment

- User approved deployment after local preview.
- Active images: warehouse Web `sha256:0f3b69e1d10b2c83483ea5a204f7384d781569502522f31214ec298e183036a3`; Worker `sha256:393dfae2d3f0320f6cdc29c8681718dc127d06314fadd486b03d6b8cc77bcf88`.
- Rollback checkpoint: `/root/jiawang-backups/review-loyalty-colors-20260816-v3` and matching rollback tags.
- Production data counts are unchanged: 29 categories, 4 products, 5 variants, 1 import job, 9 import items, 19 pipeline assets, and 19 media files. SQLite `quick_check=ok`; migration count remains 16.
- Authenticated public acceptance verified `/warehouse/catalog/new`, optional review opinion, empty-opinion return/delete readiness, and working `/warehouse/api/v1/media/*` images. No production review decision was submitted.

## 2026-08-16 manual product deployment

- User approved the local preview before deployment.
- Deployed only warehouse Web and Worker with migration `020_product_entry_source.sql`; order Web/database and AI configuration were not changed.
- Active images: Web `sha256:4b69fa062c2fe864e5741bb5596a64515747f955b6af0ba97afe6f6d78796b15`; Worker `sha256:5500b738894e8f83cd7de5b364e3b931e687b91d15c0c6885f84e5d9ffc4f1c4`.
- Rollback: `/root/jiawang-backups/20260816-120027-manual-product`, `/data/db/app-before-manual-product-20260816-120027.sqlite`, and `/opt/jiawang-commerce-new/佳旺仓库系统.rollback-20260816-120027`.
- Production verification passed: database quick check, migration count 16, Web health, Worker health, public manual-product page, unauthenticated RBAC checks, and recent error-log scan.

本项目已从空目录完成主体绿地实现，目前处于 M6 收尾验收。接管时先读 `TASK_STATE.md`、`WORKING_SET.md`、`PLANS.md`、`DECISIONS.md` 及当前 `git status`；不要读取 archive 或复制任何用户凭据。

## 已交付能力

Next.js App Router + React/TypeScript/Tailwind 页面和 `/api/v1` REST API 已建立；web/worker/proxy Compose 分离，SQLite WAL/迁移/写租约和 Docker named volume 约束已写入配置。登录、会话撤销、密码修改、三角色 RBAC、Origin/CSRF、限流和不可变审计已实现。

上传链支持分块断点和幂等 SHA-256、原子文件提交；ZIP 流式安全解压拒绝路径穿越、绝对/UNC/ADS、保留名、符号链接、嵌套/加密包、CRC 错误、zip bomb、超大条目和像素炸弹。派生图使用 Sharp（无 Sharp 时有保守降级）并去除 EXIF/GPS。

持久化 Worker 执行 unpacking/preprocessing/classifying/grouping/extracting/review_pending/completed 阶段；Mock provider 可离线跑通，DeepSeek provider 只接受显式 HTTPS/allowlist/模型配置并做视觉能力探测、schema 校验、重定向/SSRF/超时防护。token 预留、结算、未知 usage 暂停和 SSE `Last-Event-ID` 回放已接入。AI 结果只能进入候选/evidence；人工审核、revision、发布门槛、商品查询和 published-only Excel/CSV/图片清单导出已实现。

管理员可手动创建加密 `.jwbackup`，内容含数据库一致性快照、媒体、manifest、schema/app/prompt/pricing 版本；恢复前自动留底，验证完整性/外键/空间后在同卷 staging 原子切换并保留 rollback journal。下载采用流式一次性锁；不确定状态 fail-closed。密码和环境 API key 不进入备份。

## 本轮收尾变更

已补任务 `POST /api/v1/import-jobs/:id/pause|resume|retry`、协作式 Worker 暂停、导出全量分页/流式下载和备份下载锁恢复；相关 UI 与测试已更新。AI 私有/回环端点必须显式开启，避免生产 SSRF 绕过。

## 验证与阻断

`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd test`（30 PASS、2 SKIP）、平台/配置 smoke test 和 `npm.cmd run build` 已通过。2 个 SQLite 集成用例因当前 Node 24 缺少 `better-sqlite3` native binding 跳过；目标 Node 20 Docker 运行、真实 DeepSeek 探测、HTTPS 证书、真实灾备演练、压测和金集报告均为 `NOT RUN`，不能用 mock 结果替代。

下一位代理应先获取独立 reviewer/acceptance 报告，修复关键 FAIL 后更新状态文件并创建首个 Git 基线提交；不得使用 `git reset --hard` 或宽范围删除。
