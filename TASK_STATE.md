# Task State

## 2026-08-23 发布构建与资料保存验收

### 已完成

- 固定发布失败证据：平台日志在 `load local bake definitions` 后、项目 Dockerfile 步骤前终止。
- 连续失败根因相同：BuildKit 内部 `x-docker-expose-session-sharedkey` 含不可打印字符，gRPC 会话无法建立。
- 新增 `pnpm run validate:compose-build`，不读取或输出密钥，检查四服务上下文、Dockerfile target、启动文件、健康路径、入口标签和镜像复用关系。
- 订单 Web 与媒体 Worker 复用根镜像；仓库 Web/Worker 分别使用 `web` / `worker` target；gateway 为唯一入口。
- 客户资料更新不再强依赖旧库时间字段；旧数据库连续初始化两次、连续保存两次、SQLite `quick_check` 均通过。
- 首次资料、重复编辑、多地址、默认地址切换及下单前拦截通过。
- 根项目类型检查、生产构建、安全回归、路由资源检查、SQLite 安全检查和源码发布契约检查通过。

### 当前限制

- 沙箱中没有 Docker/Podman，不能宣称 Compose `config`、镜像构建、容器启动、healthcheck、隔离命名卷和备份恢复演练已通过。
- 平台 BuildKit 内部会话头不是项目环境变量，项目代码不能也不应修改它。
- `git not found` 是构建元数据警告，不是镜像构建阻塞。

### 下一发布动作

1. 平台清理并重新生成只含可打印字符的 BuildKit 会话密钥。
2. 重试发布；若能进入 Dockerfile 步骤，再按具体 Dockerfile/依赖错误处理。
3. 若仍在同一握手位置失败，停止业务代码修改并转平台基础设施处理。
4. 在具备 Docker 的隔离 Node 20/Linux 环境完成 `HANDOFF.md` 所列容器级验收，不访问或重建生产数据和命名卷。

### 本轮回归结果

- `pnpm run validate:compose-build`：PASS；明确提示当前沙箱没有 Docker。
- 根项目 `typecheck`、`build`、`test:security`、`test:router-chunks`、客户资料旧库与地址流程：PASS。
- 仓库 `typecheck`、`test:config`、`test:platform`、`test:migration-021`、`lint`：PASS；lint 为 0 errors、15 warnings。
- 仓库全量测试：75 pass / 2 fail；失败仍为既有 AI profiles 与 manual product routes 业务测试，未因发布配置修改而扩大。
- `sqlite_safety_lint` 与 `source_contract_lint`：PASS。
