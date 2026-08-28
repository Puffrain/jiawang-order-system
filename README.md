# 佳旺订单系统

[English](README_EN.md) | 中文

佳旺订单系统是一个订单、商品、仓库和媒体同步一体化的单仓库项目。当前业务重点是人工录入商品、人工审核发布和订单履约；AI 配置仅保留接口，不影响人工流程。

## 系统组成

- 订单 Web：客户登录、商品浏览、购物车、订单、聊天和商户管理。
- 订单媒体 Worker：异步同步仓库商品图片。
- 仓库 Web：人工商品录入、规格/库存维护、审核和发布。
- 仓库 Worker：后台任务、订单同步和媒体处理。
- Nginx 网关：订单系统使用根路径，仓库系统使用 `/warehouse`。
- SQLite：订单与仓库使用独立数据库和 Docker 命名卷。

## 技术栈

- Node.js 20、Next.js、React、TypeScript
- pnpm
- SQLite / better-sqlite3
- Docker Compose、Nginx
- GitHub Actions

## 本地开发

要求：Node.js 20、pnpm 10、Docker Desktop（隔离预览需要）。

```bash
pnpm install --frozen-lockfile
pnpm --dir 佳旺仓库系统 install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
```

订单开发服务使用 `pnpm dev`。仓库开发服务在 `佳旺仓库系统` 目录运行 `pnpm dev`。不要使用生产数据库或生产上传目录进行本地开发。

## 隔离预览

隔离预览使用全新的命名卷，不连接生产数据。先根据 `preview.env.example` 创建本地预览环境文件，再运行：

```bash
PREVIEW_ID=my-preview \
PREVIEW_ENV_FILE=/absolute/path/preview.env \
ORDER_CANDIDATE_IMAGE=repository/order@sha256:REPLACE_WITH_64_HEX_DIGEST \
WAREHOUSE_WEB_CANDIDATE_IMAGE=repository/warehouse-web@sha256:REPLACE_WITH_64_HEX_DIGEST \
WAREHOUSE_WORKER_CANDIDATE_IMAGE=repository/warehouse-worker@sha256:REPLACE_WITH_64_HEX_DIGEST \
./scripts/start-isolated-preview.sh
```

三个镜像变量必须使用本次候选版的不可变 SHA-256 摘要，不能使用 `latest`。镜像清单由 `scripts/build-node20-candidates.sh` 生成。

默认入口为 `http://127.0.0.1:3113`。订单健康接口是 `/api/health`，仓库健康接口是 `/warehouse/api/health`。

## 测试与 CI

GitHub Actions 固定使用 Node.js 20，执行秘密扫描、类型检查、Lint、生产构建、订单业务回归、跨系统同步、仓库全量测试、Compose 契约和三套候选镜像构建。

常用检查：

```bash
pnpm run scan:secrets
pnpm run test:deployment-config
pnpm run test:regression
pnpm run test:business-flows
pnpm run test:cross-system
pnpm --dir 佳旺仓库系统 test
```

## 生产配置

生产必须显式提供 `APP_ORIGIN`、`APP_MASTER_KEY`、`SESSION_SECRET` 和 `INTEGRATION_SHARED_SECRET`。真实凭据只能进入服务器的受控环境文件或操作系统凭据存储，不能提交到 GitHub、文档或聊天记录。

仓库不包含生产数据库、客户资料、上传图片、备份包、证书或真实密钥。

## 发布安全

完整流程见 [发布手册](docs/RELEASE_RUNBOOK.md)：候选镜像、隔离预览、独立审查、老板批准、在线备份、哈希校验、切换、健康检查和只读核对。

数据库迁移后出现故障时，发布脚本会停止并要求人工恢复确认，不会自动把旧程序连接到可能不兼容的新数据库。未经老板针对具体候选版本明确批准，不得修改生产环境。

## 项目资料

- [发布手册](docs/RELEASE_RUNBOOK.md)
- [阶段验收报告](docs/ACCEPTANCE_REPORT_20260828.md)
- [项目背景](PROJECT_CONTEXT.md)
- [当前计划](PLANS.md)
- [任务状态](TASK_STATE.md)

## 许可证

本项目采用 [MIT License](LICENSE)。公开仓库允许他人依据 MIT 条款使用、修改和分发源码；业务数据、商标、服务器凭据和客户资料不属于源码许可证授权范围。
