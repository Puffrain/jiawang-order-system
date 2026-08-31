import { NextResponse } from "next/server";
import { getWechatPayConfig, decryptWechatResource, hashPayload, verifyWechatNotification } from "@/lib/wechat-pay";
import db from "@/lib/db";
import { applyWechatRefundSuccess } from "@/lib/payment-state";

export async function POST(request: Request) {
  const body = await request.text();
  let notificationId = "";
  let inserted = false;
  try {
    const config = getWechatPayConfig();
    const input = { timestamp: request.headers.get("Wechatpay-Timestamp") || "", nonce: request.headers.get("Wechatpay-Nonce") || "", signature: request.headers.get("Wechatpay-Signature") || "", serial: request.headers.get("Wechatpay-Serial") || "", body };
    if (!verifyWechatNotification(input, config.publicKey, config.publicKeyId)) return NextResponse.json({ code: "FAIL", message: "签名验证失败" }, { status: 401 });
    const envelope = JSON.parse(body) as { id?: string; resource?: { ciphertext?: string; nonce?: string; associated_data?: string } };
    if (!envelope.id || !envelope.resource?.ciphertext) return NextResponse.json({ code: "SUCCESS", message: "忽略通知" });
    notificationId = envelope.id;
    const result = db.prepare("INSERT OR IGNORE INTO wechat_pay_notifications(notification_id,event_type,resource_type,resource_id,payload_hash) VALUES(?,?,?,?,?)").run(envelope.id, "REFUND.SUCCESS", "encrypt-resource", envelope.id, hashPayload(body));
    inserted = Boolean(result.changes);
    if (!inserted) return NextResponse.json({ code: "SUCCESS", message: "重复通知" });
    const resource = JSON.parse(decryptWechatResource({ ciphertext: envelope.resource.ciphertext, nonce: envelope.resource.nonce || "", associatedData: envelope.resource.associated_data || "" }, config.apiV3Key)) as { out_refund_no?: string; refund_id?: string; refund_status?: string; success_time?: string };
    if (resource.refund_status === "SUCCESS" && resource.out_refund_no && resource.refund_id) applyWechatRefundSuccess({ outRefundNo: resource.out_refund_no, refundId: resource.refund_id, successAt: resource.success_time });
    return NextResponse.json({ code: "SUCCESS", message: "成功" });
  } catch {
    if (inserted && notificationId) db.prepare("DELETE FROM wechat_pay_notifications WHERE notification_id=?").run(notificationId);
    return NextResponse.json({ code: "FAIL", message: "通知处理失败" }, { status: 400 });
  }
}
