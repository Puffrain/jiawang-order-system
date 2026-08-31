# 小程序接入任务状态

## 2026-09-01 支付退款并发保护收尾

- PASS：全额退款增加 `UNIQUE(order_id)` 约束和迁移 `003_wechat_refund_single_order.sql`；历史重复退款不会被自动删除，迁移会明确停止并报告订单号。
- PASS：退款接口遇到并发唯一约束冲突时复用已有退款记录，不会重复调用微信退款；支付和退款重复通知要求交易号/退款号一致。
- PASS：`test:migration-wechat-payments`、`test:wechat-payment-state`、`test:courier-payment`、`test:miniprogram-contract`、`typecheck`、`scan:secrets` 全部通过；`git diff --check` 通过。
- NOT RUN：本轮未重新部署服务器；当前线上商品、媒体和数据库数据保持不变，真实微信登录、支付、退款仍受平台资料和开发者工具条件限制。

## 2026-08-31 微信支付接口版本部署

- PASS：支付接口和小程序支付能力判断已提交 `01a4315` 并推送到 `release/v1.5.0-mini-courier`；未移动 `v1.5.0` 标签。
- PASS：服务器部署前备份 `/root/jiawang-backups/20260831-211440-wechat-pay-01` 校验通过。
- PASS：仅订单 Web 和媒体 Worker 切换到 `jiawang-commerce-order:wechat-pay-01`；仓库 Web、仓库 Worker、网关及生产数据卷未重建。
- PASS：公网订单和仓库健康接口返回 200；订单商品 23、有效商品 22、图片 50、缺失 0，仓库已发布商品 22、资源 50，同步待处理/死信均为 0。
- PASS：订单两个新容器重启次数为 0；支付未配置时仍安全关闭，真实微信支付和微信登录联调继续等待平台资料。
- BLOCKED：服务器 `.env` 当前未提供完整微信登录/支付资料，无法进行真实小程序登录、支付、退款和回调验收。

最新部署状态（2026-08-31）：生产 Compose 会将微信小程序和支付配置作为可选的受控环境变量传入订单服务。未配置时 Web 系统继续运行，小程序微信登录返回明确的未配置错误，支付能力保持关闭；不会伪造登录或付款成功。开发机仅设置 AppID 即可生成被忽略的上传副本，源码 AppID 保持为空且不会读取或写入 AppSecret。

最新收尾：提交 `d85db15` 已推送；服务器五个服务运行正常，订单库商品 23/图片 50、仓库已发布商品 22/资源 50 与同步队列 0 均复核通过。支付配置不完整时已安全失败；真实支付路由和微信平台联调仍未完成。

资源等级：重型。

## 2026-08-31 最终复核发现的支付配置阻塞

- BLOCKED：服务器订单容器环境变量已传入微信登录/支付配置，但 `/opt/jiawang-commerce-new/secrets` 当前只有 `wechat-pay-public-key.pem`，缺少 `wechat-pay-private-key.pem`。
- BLOCKED：服务器 secrets 目录为 `700 root:root`，公钥文件为 `600 root:root`；订单容器使用非 root 应用用户，当前无法读取挂载目录。补齐私钥后必须把 secrets 目录和文件调整为仅订单应用用户可读，不能改成公开可读。
- PASS：订单、仓库健康检查仍为 HTTP 200；本地 lint、typecheck、支付/配送员/小程序/部署契约、密钥扫描、数据库并发启动和 Webpack 构建均通过。
- PASS：GitHub 分支已更新至 `1115428`，`v1.5.0` 标签未移动；商品和媒体数据未修改。

## 本轮部署与数据保护（2026-08-31）

- PASS：订单 Web 和媒体 Worker 已部署新镜像 `jiawang-commerce-order:mini-wechat-633ad5d`；仓库 Web、仓库 Worker 和网关未重建。
- PASS：服务器默认 Compose 已更新为同一订单镜像，临时发布覆盖也指向该镜像；保留切换前 Compose 副本和服务器恢复备份。
- PASS：订单库只读检查为 `quick_check=ok`，商品 23、有效商品 22、图片 50、图片缺失 0，媒体同步待处理和失败均为 0。
- PASS：仓库库只读检查为 `quick_check=ok`，已发布商品 22、已发布资源 50、同步待处理和死信均为 0。
- PASS：订单和仓库公网健康接口均返回 HTTP 200，三套生产命名卷均存在。
- PASS：服务器支付公钥文件存在于仅服务器可读的 `secrets` 目录，订单服务以只读方式挂载该目录。
- BLOCKED：真实微信小程序登录需要服务器填写 `WECHAT_MINI_APPID` 和 `WECHAT_MINI_SECRET`，并在微信公众平台配置合法域名。当前缺失时已验证为安全失败。
- BLOCKED：真实微信支付需要完整商户配置，包括商户号、API v3 密钥、商户证书序列号、私钥文件、公钥文件、公钥 ID 与回调地址。未配置完整资料时，支付按钮和真实扣款必须保持关闭。

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
- 微信支付接口和小程序支付能力判断已预留，但尚未完成真实商户联调、退款联调、订阅消息、手机号绑定或微信平台审核。
- 真实小程序登录需要填写服务端 `WECHAT_MINI_APPID`、`WECHAT_MINI_SECRET`，并配置 HTTPS request/download 合法域名。
- 真实微信支付需要在服务器受控环境中补齐商户资料并完成回调联调；这些材料不能进入 GitHub、源码、测试夹具或日志。
