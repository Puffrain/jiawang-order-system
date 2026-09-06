# 微信小程序接入

项目内的 `miniprogram/` 是原生微信小程序客户端，继续复用现有 Next.js 买家 API。后台管理端和配送端保持不变。

## 配置

1. 在服务端环境变量中填写（生产 Compose 会拒绝缺少这两个值的启动）：
   - `WECHAT_MINI_APPID`：微信公众平台的小程序 AppID。
   - `WECHAT_MINI_SECRET`：小程序 AppSecret，仅放在服务端 `.env`，不要提交到仓库。
2. 在已配置服务器凭据的受保护环境执行 `pnpm run miniprogram:preflight`。它会检查 AppID、AppSecret、HTTPS API 地址、生产 Compose 和源码中的 AppID 边界。
3. 在开发机只设置 `WECHAT_MINI_APPID` 后，执行 `pnpm run miniprogram:prepare-upload`。它会在 `.task-runs/miniprogram-upload/` 创建被忽略的上传副本，仅在副本写入 AppID；不需要也不会读取或写入 AppSecret。源码 `miniprogram/project.config.json` 必须始终保持空 AppID。
4. 在微信开发者工具中打开该上传副本；也可以在已启用开发者工具服务端口后运行 `cli.bat open --project <上传副本路径>`。确认版本号和体验成员后，再由有发布权限的账号上传。
5. `miniprogram/utils/config.js` 默认使用当前生产来源 `https://www.kunshanjiawang.cn`。若正式域名变更，必须同步修改该值，且只能使用 HTTPS。
6. 在微信公众平台将该域名加入“request 合法域名”；商品图片使用的域名也必须加入“downloadFile 合法域名”。
7. 使用微信开发者工具打开上传副本，勾选“不校验合法域名”只适用于本地调试，发布前必须关闭。

## 已支持流程

微信登录、商品列表与详情、SKU 选择、购物车、微信地址簿导入、创建订单、订单列表及取消/修改/确认/收货/隐藏等买家操作。登录返回的 `sessionToken` 通过 `Authorization: Bearer` 发送，服务端会转换为现有会话并继续执行原有角色和业务规则。

## 当前边界

微信支付、订阅消息和线上审核资料尚未接入。真实登录必须使用已备案的小程序 AppID/Secret 和 HTTPS 合法域名。源码中的 `project.config.json` 故意保持空 AppID；直接打开源码目录运行时，点击“微信登录”不会得到有效 `wx.login` 凭证。请先按上面的 `miniprogram:prepare-upload` 生成上传副本，或在开发者工具中为当前项目配置真实 AppID，再重新编译运行。
