# Handoff

## 2026-08-31 小程序与配送员版本部署

已在既有公开仓库 `Puffrain/jiawang-order-system` 的分支 `release/v1.5.0-mini-courier` 上继续迭代并推送提交 `111c33d`，版本标签为 `v1.5.0`，未新建仓库，也未覆盖远程 `main`。订单 Web 服务和媒体 Worker 已切换到 `jiawang-commerce-order:mini-wechat-633ad5d`；仓库 Web、仓库 Worker 和网关保持原稳定镜像，生产命名卷均保留。服务器恢复点为 `/root/jiawang-backups/20260831-172653-mini-wechat-633ad5d`，切换前 Compose 副本为 `/opt/jiawang-commerce-new/compose.server.yaml.before-12c24e8`。

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
