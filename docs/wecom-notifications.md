# 企业微信订单与客户消息提醒

## 配置

在生产服务器 `/opt/jiawang-commerce-new/.env` 中加入：

```env
WECOM_BOT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=只填写企业微信机器人实际key
WECOM_BOT_MENTION_MOBILE=可选的管理员手机号
```

Webhook 只保存在服务器 `.env`，不要写入源码、截图或对话。修改后需要重新创建 `order-web` 容器，通知模块由订单主站发送。

## 通知内容

- 新订单：客户姓名、手机号、店铺名称、订单号、订单金额、提交时间。
- 客户文字消息：客户姓名、手机号、店铺名称、关联订单（如有）、消息内容。
- 客户图片消息：客户姓名、手机号、店铺名称，并提示到消息中心查看图片。

通知发送失败只记录服务端日志，不会阻塞下单或聊天。
