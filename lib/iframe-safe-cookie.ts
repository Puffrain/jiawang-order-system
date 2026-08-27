import type { NextResponse } from "next/server";

/**
 * 跨源 iframe 安全的 cookie 选项.
 *
 * 用法 (写认证/会话 cookie 时):
 *
 *   import { IFRAME_SAFE_COOKIE_OPTS } from "@/lib/iframe-safe-cookie";
 *   res.cookies.set("session", token, {
 *     ...IFRAME_SAFE_COOKIE_OPTS,
 *     maxAge: 60 * 60 * 8,
 *   });
 *
 * 直接用 ``cookies.set("session", token)`` 默认是 sameSite=lax,
 * 在跨源 iframe 内浏览器会拦掉, 用户登录后状态丢失. 一律走这个 helper.
 */
export const IFRAME_SAFE_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.SESSION_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production",
  path: "/",
};

/**
 * 便捷写法: 在 NextResponse 上设一个 iframe 安全的 cookie.
 *
 * Args:
 *     res: NextResponse 实例
 *     name: cookie 名 (例: "session")
 *     value: cookie 值 (token / 加密字符串)
 *     maxAgeSec: 过期时间 (秒), 默认 8 小时
 */
export function setSessionCookie(
  res: NextResponse,
  name: string,
  value: string,
  maxAgeSec: number = 60 * 60 * 8,
): void {
  res.cookies.set(name, value, {
    ...IFRAME_SAFE_COOKIE_OPTS,
    maxAge: maxAgeSec,
  });
}
