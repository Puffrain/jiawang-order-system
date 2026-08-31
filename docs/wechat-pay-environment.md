# 微信支付环境配置

当前版本保留支付能力接口和状态机，但未配置完整商户资料时不会发起真实扣款。

请将以下值只写入生产服务器的受控环境文件，不要写入源码、日志、测试数据或 GitHub：

    WECHAT_PAY_MERCHANT_ID=商户号
    WECHAT_PAY_API_V3_KEY=32位APIv3密钥
    WECHAT_PAY_CERT_SERIAL=商户证书序列号
    WECHAT_PAY_PRIVATE_KEY_FILE=/run/secrets/wechat-pay-private-key.pem
    WECHAT_PAY_PLATFORM_CERT_FILE=/run/secrets/wechat-pay-platform-cert.pem
    WECHAT_PAY_NOTIFY_URL=https://www.kunshanjiawang.cn/api/payments/wechat/notify

还需要在微信商户平台完成：小程序 AppID 与商户号绑定、API v3 密钥设置、商户证书下载、支付回调地址备案、退款权限开通。配置完成后再进行真实下单、回调验签、退款和对账联调。

当前验收方式：未配置时 /api/payments/capabilities 返回 NOT_CONFIGURED，小程序不得显示可点击的微信支付按钮；不能用客户端返回结果代替服务端回调。
