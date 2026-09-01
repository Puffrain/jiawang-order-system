# Handoff

## 2026-09-01 v1.5.1 发布交接

用户已明确批准“现在就上传 GitHub 这个版本，然后部署”。当前发布提交为 `7fdee81c0399bbbbec9872a8bcca622c1a982dd2`（`feat: align mini program buyer experience`），已推送至既有公开仓库 `Puffrain/jiawang-order-system` 的 `release/v1.5.0-mini-courier` 分支；新标签 `v1.5.1` 已远程核验指向该提交，未覆盖 `main` 或既有 `v1.5.0`。发布内容包含小程序五项底栏、文字消息页、图片授权缓存、商品和页面滚动体验、销售优先排序，以及相应契约检查与设计预览。小程序本地 AppID 和开发者工具开关文件仍只保留在工作区，未被提交。

本地发布门禁已通过：`test:miniprogram-contract`、`test:deployment-config`、`typecheck`、`scan:secrets`、`test:db-bootstrap`、`test:courier-payment`、`test:wechat-pay`、`test:wechat-payment-state`、聊天/移动端布局契约、13 个小程序 JavaScript 语法检查、`git diff --check` 与 Webpack 生产构建（69 个页面）。ESLint 的小程序目录不在现有 ESLint 配置覆盖范围内，因此该路径由 JavaScript 语法检查和小程序契约覆盖；Web TypeScript 已由类型检查和生产构建验证。

服务器候选源码包 SHA-256 已在解包前验证，订单候选镜像为 `sha256:6964dcbc0a985017e54f45e876065c23dffc83f99505aceaf9b2c40683c20a33`。正式发布前恢复点为 `/root/jiawang-backups/20260901-160853-v1.5.1-7fdee81`，其数据库、上传、仓库媒体、配置、镜像清单和源码备份哈希均已通过。切换后，订单和仓库两个健康接口正常，五个服务均启动；两套 SQLite `quick_check=ok`。订单侧商品 23、有效商品 22、图片 50、图片缺失 0；仓库侧已发布商品 22、资源 50；媒体和同步队列均为 0。终检脚本输出 `FINALIZE_PASS`，且四个核心服务近 10 分钟日志无阻断性错误。

仍需用户在微信开发者工具重新编译后完成真实界面验收，重点检查微信登录、图片加载、与 Web 后台双向文字消息，以及订单跳转。真实微信支付、退款和语音/富消息仍未验收，也不应对外描述为已上线。首页顶部宣传图移除、小程序语音消息和完整图片/订单/商品富消息是后续功能，未包含本次版本。

## 2026-09-01 小程序消息页与界面验收候选

用户确认继续本地界面优化，但本轮明确不部署服务器、不提交、也不推送 GitHub。已新增 `miniprogram/pages/messages/`，消息数据直接使用既有 Web 后端 `GET /api/auth/me`、`GET /api/chat/messages`、`POST /api/chat/messages`；发送方生成 `clientMessageId`，后端负责幂等和权限判断。消息页每 10 秒刷新，离开页面会清理定时器，支持文字发送、空态、加载/发送失败提示和订单跳转。复杂图片、语音、商品推荐消息没有伪造成可发送能力，首版保守展示。

小程序导航已统一为“首页 / 购物车 / 消息 / 订单 / 我的”，首页、购物车、订单、地址均可进入消息页。商品标题已限制溢出，加购按钮为固定圆形；地址和订单页面使用固定页面高度与内部 `scroll-view`，以保证无订单或数据很长时底栏仍固定。设计预览 `docs/design-previews/miniprogram-mobile-preview.html` 已增加消息页面和五项导航。

本地证据：所有相关小程序 JavaScript `node --check`、`pnpm run test:miniprogram-contract`、`pnpm run scan:secrets`、`pnpm run test:chat-order-navigation`、`pnpm run test:buyer-responsive-layout`、`git diff --check` 均通过。真实开发者工具双向聊天、商品图片缓存显示仍待用户验收。工作区原本已脏；尤其 `miniprogram/project.config.json`、`miniprogram/project.private.config.json` 是用户调试配置，绝不还原、提交或覆盖。

用户验收步骤：微信开发者工具点击“编译”，进入首页确认五项导航、标题和圆形加购按钮；进入“消息”确认可以看到 Web 后台相同的历史消息；从小程序发一条文字，在 Web 后台“客户消息”确认出现；再从后台回复，回小程序等待约 10 秒或切换页面回来确认收到。随后检查地址和订单页面在空数据、长数据下底栏固定。只有用户再次明确批准后，才开始独立审查、提交、推送或服务器发布。

## 2026-09-01 小程序微信登录配置与登录页样式

用户在微信开发者工具检查时发现登录页按钮文字过大，且微信登录提示"小程序服务尚未配置"。根因分离后处理：微信原生 `button` 没有稳定继承页面字号，已在 `miniprogram/app.wxss` 指定 `28rpx`，登录页分别指定按钮和错误提示字号；静态小程序契约增加对应保护。

服务器根因是 `/opt/jiawang-commerce-new/.env` 未设置 `WECHAT_MINI_APPID`、`WECHAT_MINI_SECRET`。从本地受控 `server.env` 仅同步这两项，保留服务器更新前 `.env` 备份 `.env.before-mini-login-20260901-110933`，并受控重建 `order-web`。五个服务仍为 running；服务器临时源文件和临时脚本已删除，容器两项变量只以脱敏方式确认存在。

已通过 `pnpm run test:miniprogram-contract`、两份登录 JS 的 `node --check` 和 `git diff --check`。真实登录尚待用户在微信开发者工具重新编译后点击微信登录，用实际 `wx.login` 生成的一次性 code 验收；不得以无效 code 或生产用户数据替代。当前样式源码未提交或推送，且用户的 `miniprogram/project.config.json`、`miniprogram/project.private.config.json` 改动必须排除。

## 2026-09-01 网页买家端可滚动列表候选版本

用户要求网页买家端的商品列表参考外卖应用的使用方式：商品内容和分类栏在固定可见区域中独立上下滚动；同时将误用库存排序的 "库存优先" 修正为真实 "销量优先"。本轮只修改了 `app/buyer/page.tsx`、`components/buyer/catalog-home.tsx`、`lib/product-catalog.ts` 和两项相关契约测试；没有修改或检查小程序页面。

真实销量定义为累计已收款、未退款、未删除订单中的 `order_items.quantity`。聊天页外层现在提供视口高度，原有 `ChatPanel` 的 flex 和内部滚动逻辑因此生效，输入框保持在底部。已通过买家响应式和聊天跳转契约、TypeScript、改动文件 ESLint、密钥扫描、空白检查和 `next build --webpack`。`test:product-flow` 因缺少隔离的 `TEST_OWNER_PHONE`、`TEST_OWNER_PASSWORD` 被阻塞，未使用真实账号绕过。

工作树仍包含用户自己在微信开发者工具产生的 `miniprogram/project.config.json`、`miniprogram/project.private.config.json` 改动，绝不可恢复、提交或覆盖。本轮未部署、未提交、未推送；若后续准备发布，须先独立审查候选 diff、让用户确认浏览效果，并仅暂存上述 5 个网页和测试文件。

## 2026-09-01 并发退款保护与最终本地验收

本轮新增退款竞态保护：`wechat_refunds` 对每个订单只允许一条全额退款记录，新增迁移脚本和幂等迁移测试；退款接口在并发唯一约束冲突时返回已有记录，不重复调用微信退款。支付成功和退款成功通知在重复到达时分别校验交易号、退款号完全一致，小程序支付按钮继续由服务端能力接口控制。

本地验证证据：`pnpm run test:migration-wechat-payments`、`pnpm run test:wechat-payment-state`、`pnpm run test:courier-payment`、`pnpm run test:miniprogram-contract`、`pnpm run typecheck`、`pnpm run scan:secrets` 和 `git diff --check` 均通过。当前改动尚未部署服务器；生产环境仍保持上一版运行状态，未修改商品、图片、媒体或数据库。

下一步：提交并推送当前分支后，再按受控流程部署；真实微信登录、支付、退款和开发者工具验收仍标记 BLOCKED，直到服务器补齐 AppID/Secret、支付公钥与私钥权限、合法域名及开发者工具服务端口。

## 2026-08-31 最终复核阻塞

本地代码验收已通过：lint（0 error，3 条既有 warning）、typecheck、微信支付契约、配送员/支付契约、小程序契约、部署配置、密钥扫描、数据库并发启动和 `next build --webpack` 均通过。GitHub 分支 `release/v1.5.0-mini-courier` 已推送提交 `1115428`，正式标签 `v1.5.0` 仍未移动。

服务器当前的真实阻塞是支付私钥和文件权限：订单容器环境变量已传入，但 `/opt/jiawang-commerce-new/secrets` 只有 `wechat-pay-public-key.pem`，缺少 `wechat-pay-private-key.pem`；目录为 `700 root:root`，公钥为 `600 root:root`，非 root 订单用户无法读取。补齐私钥后需要在服务器上将目录/文件设为仅订单应用用户可读，再重启订单 Web 和媒体 Worker并验证支付能力接口；不得把文件改成所有用户可读，也不得上传到 GitHub。当前支付会安全返回 `NOT_CONFIGURED`，商品、图片、仓库媒体和 Web 系统不受影响。

## 2026-08-31 微信支付接口部署收尾

提交 `01a4315` 已推送到 `release/v1.5.0-mini-courier`，`v1.5.0` 未移动。服务器已保留备份 `/root/jiawang-backups/20260831-211440-wechat-pay-01`，订单 Web 和媒体 Worker 切换到 `jiawang-commerce-order:wechat-pay-01`；仓库服务、网关和商品/媒体数据卷未重建。公网两个健康接口均为 200，订单商品 23、图片 50、缺失 0，仓库已发布商品 22、资源 50，同步队列为 0，订单容器重启次数为 0。未配置完整微信资料时支付能力继续关闭；真实登录、支付和退款联调仍需微信平台配置。

## 2026-08-31 支付安全收尾与数据复核

分支 `release/v1.5.0-mini-courier` 最新提交为 `d85db15`（`fix: fail closed for incomplete wechat payment config`），已推送到 `Puffrain/jiawang-order-system`；正式标签 `v1.5.0` 仍指向 `111c33d`，未覆盖或移动。支付能力现在要求商户号、32 位 API v3 密钥、证书序列号、实际存在的私钥和微信支付公钥文件、公钥 ID 以及 HTTPS 回调地址，资料不完整时返回 `NOT_CONFIGURED`；真实支付意图、通知回调和退款联调尚未实现，不能宣称真实支付已上线。

服务器 `/opt/jiawang-commerce-new` 当前五个服务均为 running，订单和仓库公网健康接口均返回 200。只读数据复核通过：订单库 quick_check=ok，商品 23、有效商品 22、图片 50、缺失 0、订单 4、媒体待处理/失败 0；仓库库 quick_check=ok，商品 22、已发布商品 22、关联资源 50、流水线资源 100、同步待处理/死信 0。三个生产命名卷和既有恢复备份均保留，未删除商品、图片、媒体或其他生产数据。

本地临时压缩包和临时脚本已清理，未进入 Git。后续仍需在受控服务器环境补齐真实微信 AppID/Secret、合法域名和完整支付商户资料，再进行微信开发者工具及沙箱/小额支付联调。

## 2026-08-31 小程序与配送员版本部署

已在既有公开仓库 `Puffrain/jiawang-order-system` 的分支 `release/v1.5.0-mini-courier` 上继续迭代并推送最新提交 `1098592`；版本标签 `v1.5.0` 仍指向已发布的 `111c33d`，未新建仓库，也未覆盖远程 `main`。订单 Web 服务和媒体 Worker 已切换到 `jiawang-commerce-order:mini-wechat-633ad5d`；仓库 Web、仓库 Worker 和网关保持原稳定镜像，生产命名卷均保留。服务器恢复点为 `/root/jiawang-backups/20260831-172653-mini-wechat-633ad5d`，切换前 Compose 副本为 `/opt/jiawang-commerce-new/compose.server.yaml.before-12c24e8`。

本次只读数据验收：订单库 `quick_check=ok`，商品 23、有效商品 22、商品图片 50、图片文件缺失 0、媒体同步待处理和失败均为 0；仓库库 `quick_check=ok`，已发布商品 22、已发布资源 50、同步待处理和死信均为 0。仓库媒体卷当前有 100 个文件。没有删除商品、图片、媒体、订单、用户或任何生产数据卷；用户虽允许删除测试用户数据，但本次无需删除。

公网 `https://www.kunshanjiawang.cn/api/health` 与 `https://www.kunshanjiawang.cn/warehouse/api/health` 均返回 200。默认服务器 Compose 和临时发布覆盖均引用新订单镜像，因此容器重启后不会回退。服务器的支付公钥文件已经存在并通过只读挂载提供给订单服务，但 `WECHAT_MINI_APPID`、`WECHAT_MINI_SECRET` 以及支付商户关键配置仍未完整提供，故真实微信登录和真实微信支付不属于本次已验收能力。未配置时接口必须安全失败，Web 端不受影响。

后续最小动作：在微信公众平台和微信支付商户平台完成合法域名、AppID/AppSecret、商户号、API v3 密钥、商户证书序列号和微信支付公钥 ID 的受控服务器配置，再使用真实小程序代码和沙箱/小额支付进行联调。不要把凭据、私钥、公钥或 `.env` 提交到 GitHub。

## 2026-08-29 订单生命周期与配送员发布

老板已批准发布 `order-lifecycle-courier-20260829-r2`，候选源码为公开仓库 `main` 的 `51f4b1519cd4f14158f30ac9775385af257e9259`。发布前候选包 SHA-256 为 `57660c1bb8da42c12419ebebc8a4611844e097bd54eb863e4da460cd8186efcc`，已在服务器完成核验后再解包。

发布包含客户和商家双方确认订单、发货前客户撤回及修改、配送员独立登录和送达确认、快递单号与查询、货到付款确认，以及保留但默认关闭的微信支付和支付宝接口。人工商品录入仍是主流程，未启用 AI 或在线支付。

发布前已保留完整恢复点 `/root/jiawang-backups/20260829-132121-order-lifecycle-courier-20260829-r2`。已部署不可变镜像：订单 `sha256:89aabd594f6593310ac357a631fa6a2d436a7c0856a6efb60d30a82f33129fad`、仓库 Web `sha256:89ccfa76722f363d4b3b507fce95f123174e1712033aee3327dd3c749568f853`、仓库 Worker `sha256:2764a1533ca58095ebf1d5009f7a4448cf6483eadba6518f955270a8d8eb12d9`。

切换和终检分别输出 `PREPARE_PASS`、`FINALIZE_PASS`。订单与仓库健康接口正常，五个服务均为 `running` 且重启次数为 0；网关继续绑定 `127.0.0.1:8080:80`。发布后只读数据核对通过：两库 `quick_check=ok`，订单商品 23、有效商品 22、图片 50 且无缺失，仓库已发布商品 22、资源 50，待处理或死信同步均为 0。

本机未安装 Node 导致原发布预检的静态检查无法直接运行；本次在已构建候选订单镜像中只读运行同一检查并通过，未在主机安装软件或修改生产配置。后续应单独改进发布脚本，使其明确支持无主机 Node 的 Docker 运行时。独立 reviewer 与 acceptance 尚未完成，因此旧镜像、命名卷和备份继续保留，不执行清理。

## 2026-08-28 baseline-v2 阿里云部署

老板已批准把测试服务器升级到公开仓库标签 `baseline-v2`（提交 `89fbe24`），保留并迁移现有商品数据，旧程序可清理。部署主机为 `101.132.41.57`，应用目录 `/opt/jiawang-commerce-new`。

上线前已生成并验证完整备份 `/root/jiawang-backups/20260828-162713-baseline-v2`，包含两套 SQLite、订单上传、仓库媒体、源码、Compose 和镜像信息。源码通过本地 `git archive baseline-v2` 传输，压缩包 SHA-256 为 `97235e4f038b908be499a41af6580342c59f739b32737a2f2c08621a02cb3f86`，远端文件数 458，关键配置核对通过。

三套候选镜像已构建并上线：订单 `c6494f39...`、仓库 Web `ba9de5da...`、仓库 Worker `0f0e1e69...`。中国网络构建使用阿里云 Debian 镜像和 npmmirror；正式源码未因镜像站改变。旧 `.env` 的 `APP_MASTER_SECRET` 已在服务器内部原值改名为 `APP_MASTER_KEY`，值与运行容器一致，原文件保留为权限 600 的备份。

切换后发现外层 Nginx 固定转发 `127.0.0.1:8080`，而候选 Compose 未发布该端口。生产镜像覆盖配置已为 gateway 增加 `127.0.0.1:8080:80`，只重建网关后恢复内外健康。五个容器均 `running`、`restart=0`；公网 HTTPS、两个内部健康接口均通过。

迁移前后数据一致：订单侧 products=23、productImages=50、imageFilesMissing=0；仓库侧 publishedProducts=22、publishedAssets=50；两库 `quickCheck=ok`，pending/failed/dead 队列均为 0。终检脚本输出 `FINALIZE_PASS`。

旧镜像尚未清理，已校验备份必须保留。独立 reviewer/acceptance 子代理工具连续返回参数解析错误，本轮不能把主代理终检冒充独立复核；下一步优先补做只读独立审查，再决定清理旧镜像。
