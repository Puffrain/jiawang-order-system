# 发布交接与故障分类

## 当前候选版本

- 项目侧静态构建基线：PASS。
- 四服务契约：订单 Web / 订单媒体 Worker 复用根镜像；仓库 Web 使用 `web` target；仓库 Worker 使用 `worker` target；gateway 为唯一入口。
- 构建上下文：订单服务为工作区根目录，仓库服务为 `./佳旺仓库系统`。
- 仓库健康路径：`/warehouse/api/health`，与 `/warehouse` base path 一致。
- 资料保存与地址流程：PASS；旧数据库兼容初始化与连续保存：PASS。

## 当前环境证据

`pnpm run validate:compose-build` 已通过，输出了服务、上下文和 target 摘要；当前沙箱没有 Docker，因此 Compose `config --quiet`、镜像构建、容器启动和 healthcheck 未宣称通过。

根项目已通过：

- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run test:security`
- `pnpm run test:router-chunks`
- `pnpm run test:customer-profile-legacy`
- `pnpm run test:customer-profile-address`
- `source_contract_lint`
- `sqlite_safety_lint`

## 平台 BuildKit 故障分类

如果日志在读取项目 Dockerfile 之前出现以下内容：

- `load local bake definitions`
- `failed to dial gRPC`
- `x-docker-expose-session-sharedkey contains value with non-printable ASCII characters`
- `error reading preface from client`

则分类为平台 BuildKit 会话握手失败，不是 Dockerfile、Compose、应用依赖或业务代码失败。不得在项目中清洗、覆盖或伪造该内部请求头；平台应清理并重新生成构建会话密钥后重试。

`git was not found in the system` 只影响构建元数据采集，不影响应用镜像构建。

## Docker 可用环境的验收命令

在隔离 Node 20/Linux 主机执行，不连接生产数据库，不使用生产 `.env`，不删除或重建任何生产卷：

```sh
pnpm run validate:compose-build
docker compose --env-file preview.env.example -f compose.preview.yaml config --quiet
docker compose -p jiawang-isolated -f compose.yaml config --quiet
docker compose -p jiawang-isolated build order-web order-media-worker warehouse-web warehouse-worker
docker compose -p jiawang-isolated up -d
docker compose -p jiawang-isolated ps
docker compose -p jiawang-isolated down
```

健康检查需覆盖订单 `/api/health`、仓库 `/warehouse/api/health`、gateway 同源代理和 worker health。备份恢复必须使用临时命名卷和测试数据库，先做 `quick_check`，再两次幂等迁移和只读核对；不得把隔离结果写回生产。
