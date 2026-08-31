# 小程序接入任务状态

最新发布准备复核（2026-08-30）：生产 Compose 缺少 `WECHAT_MINI_APPID` 或 `WECHAT_MINI_SECRET` 时拒绝启动；服务器预检会校验两项凭据和 HTTPS API 地址。开发机仅设置 AppID 即可生成被忽略的上传副本，源码 AppID 保持为空且不会读取或写入 AppSecret。

资源等级：标准。

## 本轮界面规划与实现（2026-08-31）

- PASS：小程序客户端首页、购物车、订单、地址页统一为浅灰背景、白色内容区、橙色主操作，并补充与 Web 手机端一致的底部导航入口。
- PASS：订单页增加“全部 / 待处理 / 配送中 / 已完成”筛选；配送员工作台增加“待配送 / 配送中 / 已完成”筛选。
- PASS：商品详情继续保留规格、库存、数量和固定加入购物车操作；结算从购物车进入地址选择，不改变服务端权限。
- PASS：品牌宣传图继续作为本地忽略资源使用，路径为 `miniprogram/assets/brand-banner.jpg`，未进入 GitHub。
- PASS：本轮全部小程序 JavaScript 通过 `node --check`，`pnpm run test:miniprogram-contract` 通过，`git diff --check` 无空格错误。

## 目标

在保留现有 Web 管理端和配送端的前提下，提供可由微信开发者工具打开的原生小程序买家端，并复用现有订单 API。

## 已完成

- 原生小程序页面：登录、商品、商品详情/SKU、购物车、地址、订单。
- 服务端微信 `jscode2session` 登录、买家账户复用/创建、会话令牌返回。
- Bearer 会话转换为现有 `hs_session`，保留来源校验和路由业务鉴权。
- 订单列表补充生命周期字段，确认动作使用实际版本字段。
- 配置文档、环境变量示例、小程序静态契约检查。

## 验证证据

- PASS：`pnpm run test:miniprogram-contract`。
- PASS：全部小程序 JavaScript `node --check`。
- PASS：`pnpm run typecheck`。
- PASS：改动文件 ESLint。
- PASS：`pnpm run test:deployment-config`。
- PASS：`pnpm run scan:secrets`，最终复跑通过。
- PASS：`pnpm run test:db-bootstrap`，8 个并发进程在独立 SQLite 数据库上初始化通过。
- PASS：短路径 Junction、独立数据库和 Webpack 模式下的生产构建完成：编译、TypeScript、66 个静态页面生成、构建收尾和 trace 收集均通过。
- PASS：隔离本地服务接口验收：未配置微信凭证时 `POST /api/auth/wechat/login` 返回 503；无会话访问 `GET /api/products` 返回 401；买家 Bearer 会话访问该 API 返回 200。
- PASS：本轮复验 `pnpm run test:miniprogram-contract`、`pnpm run test:deployment-config`、`pnpm run typecheck`、`pnpm run scan:secrets`，以及 9 个小程序 JavaScript 文件的 `node --check` 均通过。
- PASS：本轮 `pnpm run test:db-bootstrap` 通过。首次复测曾暴露 SQLite 多进程启动时在 `journal_mode` 切换阶段发生 `SQLITE_BUSY`；现改为不在每次进程启动时切换日志模式，并在独占初始化锁下完成迁移，已通过针对性复验。
- PASS：小程序端 API 地址固定为 `https://www.kunshanjiawang.cn`，源码不内置 AppID；根 Compose 和预览 Compose 均向订单服务传递微信登录环境变量。
- PASS：本轮使用短路径 Junction、独立 SQLite 数据库和 `next build --webpack` 完成生产构建复验：编译、TypeScript、66 个静态页面生成、构建收尾和 trace 收集均通过。
- 环境限制：默认 Turbopack 构建仍会受当前 Windows 工作区路径过深影响，验证通过的发布构建命令应使用 Webpack 或缩短检出路径。
- 环境限制：本轮验证创建的 `C:\jw-mini-build` Junction 和 `data/mini-build-verify.db` 为可删除临时产物；删除操作被本机安全策略拦截，未影响源码、构建结果或密钥边界。
- 环境限制：微信开发者工具 CLI 验证返回“IDE service port disabled”，需要在开发者工具“设置 -> 安全设置”手动开启服务端口；未进行重复尝试。

## 未完成与边界

- 尚未使用真实 AppID/Secret 在微信开发者工具中登录验收。当前接口已验证未配置凭证时的安全失败路径；真实 `jscode2session` 依赖微信公众平台配置。
- 微信平台验收仍需具备真实账号权限、AppID/Secret、合法域名和开发者工具服务端口；这些外部条件未在当前工作区提供。
- 尚未接入微信支付、订阅消息、手机号绑定。
- 发布前必须填写服务端 `WECHAT_MINI_APPID`、`WECHAT_MINI_SECRET`，并配置 HTTPS request/download 合法域名。
- 未进行真实微信支付、订阅消息、手机号绑定，也未完成微信平台审核；这些能力不在本次交付范围。
