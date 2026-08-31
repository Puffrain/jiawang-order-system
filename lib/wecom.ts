type CustomerInfo = {
  displayName: string | null;
  phone: string | null;
  shopName?: string | null;
};

type WecomResult = { errcode?: number; errmsg?: string };

const webhookUrl = () => process.env.WECOM_BOT_WEBHOOK_URL?.trim() || "";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5000;

export function parseMentionMobiles(value = "") {
  return [...new Set(
    value
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(item => item === "@all" || /^\d{11}$/.test(item)),
  )];
}

function customerLabel(customer: CustomerInfo) {
  const name = customer.displayName?.trim() || "未填写姓名";
  const phone = customer.phone?.trim() || "未填写手机号";
  const shop = customer.shopName?.trim();
  return shop ? `${name}（${phone}，${shop}）` : `${name}（${phone}）`;
}

function failureReason(error: unknown) {
  if (error instanceof Error) {
    const match = error.message.match(/^(HTTP_\d+|WECOM_-?\d+|TIMEOUT)$/);
    return match?.[1] || "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

async function send(content: string) {
  const url = webhookUrl();
  if (!url) return;
  const mentionedMobiles = parseMentionMobiles(process.env.WECOM_BOT_MENTION_MOBILE);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content, mentioned_mobile_list: mentionedMobiles } }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const result = await response.json().catch(() => null) as WecomResult | null;
      if (result?.errcode && result.errcode !== 0) throw new Error(`WECOM_${result.errcode}`);
      return;
    } catch (error) {
      const reason = error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : failureReason(error);
      if (attempt === MAX_ATTEMPTS) {
        console.error("wecom notification failed", { reason, attempts: attempt });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 250));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function notifyNewOrder(input: {
  customer: CustomerInfo;
  orderNo: string;
  totalAmount: number;
  createdAt?: string;
}) {
  const time = input.createdAt || new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return send([
    "【佳旺新订单】",
    `客户：${customerLabel(input.customer)}`,
    `订单号：${input.orderNo}`,
    `订单金额：¥${Number(input.totalAmount).toFixed(2)}`,
    `提交时间：${time}`,
    "请及时进入订单后台确认。",
  ].join("\n"));
}

export function notifyCustomerMessage(input: {
  customer: CustomerInfo;
  messageType: "文字" | "图片";
  content?: string;
  orderNo?: string | null;
}) {
  return send([
    "【佳旺客户消息】",
    `客户：${customerLabel(input.customer)}`,
    input.orderNo ? `关联订单：${input.orderNo}` : "关联订单：无",
    `消息类型：${input.messageType}`,
    input.content ? `内容：${input.content.slice(0, 500)}` : "内容：客户发送了一张图片，请进入消息中心查看。",
    "请及时回复客户。",
  ].join("\n"));
}
