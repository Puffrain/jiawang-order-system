# Task State

## 2026-08-28 首次规范接管与发布安全整改

资源等级：重型
当前状态：PR #1 修复 acceptance 发现的镜像启动阻断
生产状态：保持不变，未获最终候选版发布批准

### 已完成

- 431 个随包文件均存在；接管前 51 个指纹差异记录为待审计变化，没有误报为损坏或攻击。
- 接管恢复点、未验证导入提交和 `unverified-import-20260827` 标签已建立。
- 人工商品全链路通过：图片、规格、价格、库存、待审核、人工批准、发布、订单同步、媒体同步和客户展示；审核前 outbox=0。
- 仓库 Node 20 Linux 测试 78/78、订单/仓库类型检查、Lint、构建、部署契约和秘密扫描已有通过证据。
- 隔离预览完成桌面/手机浏览器检查；两套 SQLite `quick_check=ok`；备份哈希、媒体核对、恢复和两次迁移演练通过。
- 阿里云只做过老板授权的只读盘点；生产商品数据库、媒体、容器和系统配置未修改、未删除、未下载。
- GitHub 公开仓库 `Puffrain/jiawang-order-system` 已建立，采用 MIT License；`main` 启用必需 `verify`、一次审批、管理员强制、线性历史、禁止强推和删除。
- `baseline-v1` 指向绿色 CI 基线 `3ff147b`。
- 老板确认 AI 接口保留但暂停扩展，人工录入是本轮关键流程。

### 独立审查与验收

- reviewer：首轮 REVIEW FAIL；修复后最终复审 REVIEW PASS。
- acceptance：独立恢复演练通过哈希、SQLite、媒体、全表计数和两次迁移，但订单镜像默认入口因运行期 Corepack 解析到 pnpm 11.24 而失败，最终结论 ACCEPTANCE FAIL。

### PR #1 整改

- 分支 `fix/release-safety-readme`，最新提交 `dbb32f9`，PR：`https://github.com/Puffrain/jiawang-order-system/pull/1`。
- 迁移后故障改为 `MANUAL_RECOVERY_REQUIRED`，禁止自动把旧镜像连接到可能已迁移的数据库。
- 终检默认要求缺图、待处理/失败媒体、待处理/死信同步均为 0；关键错误日志会阻断成功结论。
- 订单 Web/媒体 Worker 改为 UID 1001 非 root，新增一次性卷权限初始化并启用 `no-new-privileges`。
- CI 增加订单业务流、跨系统同步、归档、积分、投影、媒体并发、数据库并发和终检阈值运行测试。
- 新增中文 `README.md` 和英文 `README_EN.md`，说明架构、开发、隔离预览、测试、生产配置、发布安全和许可证。
- 本地验证通过：发布/Compose 契约、秘密扫描、订单类型检查、Lint、生产构建、关键运行时测试、终检阈值测试、订单镜像构建、UID 1001 和全新临时卷写入。
- GitHub Actions run `33140776035` 全部通过：订单验证、仓库验证和三套候选镜像构建均为 success。
- 最新绿色 run `33141622415` 对应提交 `995b4fe`；它只验证镜像构建，尚未验证镜像默认入口。
- 当前修复将订单 Web 和媒体 Worker 改为 Node 直接启动，避免普通用户触发 Corepack 下载；本地新镜像健康接口 200，Web/Worker 均以 `order` 用户运行且 `restart=0`。
- CI 已增加订单镜像实际启动、健康检查、非 root 身份、Worker 存活和零重启 smoke test。

### 当前待办

- 提交并推送镜像入口修复，等待新 CI。
- 新 CI 通过后，由独立 reviewer 和 acceptance 针对新提交复审。
- 全部关键项通过后，才向老板申请具体候选版的生产发布批准。
