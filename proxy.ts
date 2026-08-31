import { NextRequest, NextResponse } from "next/server";
import { AUTH_MARKER_COOKIE, verifyAuthMarker } from "@/lib/auth-marker";
import { securityHeaders } from "@/lib/security";

const publicPaths = ["/", "/admin/login", "/buyer/login", "/customer-entry", "/api/health", "/api/qr", "/api/auth/admin/login", "/api/auth/admin/send-reset-code", "/api/auth/admin/reset-password", "/api/auth/buyer/send-code", "/api/auth/buyer/login", "/api/auth/buyer/register", "/api/auth/buyer/password-login", "/api/auth/buyer/reset-password", "/api/auth/wechat/login", "/api/luffy-platform-error"];
const ownerPrefixes = ["/admin/", "/diagnostics", "/setup-guide", "/orders/", "/api/exports", "/api/docs/setup"];

function withSecurity(response: NextResponse) {
  for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, process.env.NODE_ENV === "production" && name === "Content-Security-Policy" ? value.replace(" 'unsafe-eval'", "") : value);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const bearerToken = bearer || "";
  const bearerApi = Boolean(bearerToken && bearerToken.length <= 512 && pathname.startsWith("/api/"));
  const requestHeaders = new Headers(request.headers);
  if (bearerApi) {
    const cookie = requestHeaders.get("cookie");
    requestHeaders.set("cookie", (cookie ? cookie + "; " : "") + "hs_session=" + encodeURIComponent(bearerToken));
  }
  if (pathname.startsWith("/_next") || pathname.startsWith("/brand/") || pathname === "/favicon.ico" || publicPaths.some(path => pathname === path || pathname.startsWith(`${path}/`))) return withSecurity(NextResponse.next());
  if (pathname === "/warehouse" || pathname.startsWith("/warehouse/")) return withSecurity(NextResponse.next());
  // Internal service routes authenticate themselves with a signed, replay-
  // protected request. They must not depend on a browser session cookie.
  if (pathname.startsWith("/api/internal/")) return withSecurity(NextResponse.next());

  // 微信小程序登录没有浏览器会话，wx.request 会被标记为跨站请求。
  // 该接口只接收一次性 code，并由微信服务端校验，因此不适用网页 CSRF 来源检查。
  const isWechatLogin = pathname === "/api/auth/wechat/login";
  if (pathname.startsWith("/api/") && !isWechatLogin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (requestHeaders.get("sec-fetch-site") === "cross-site") return withSecurity(NextResponse.json({ error: "请求来源无效" }, { status: 403 }));
    const origin = requestHeaders.get("origin");
    const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
    if (origin && host && new URL(origin).host !== host) return withSecurity(NextResponse.json({ error: "请求来源无效" }, { status: 403 }));
  }
  if (bearerApi) return withSecurity(NextResponse.next({ request: { headers: requestHeaders } }));

  const role = await verifyAuthMarker(request.cookies.get(AUTH_MARKER_COOKIE)?.value);
  const ownerOnly = pathname === "/admin" || pathname.startsWith("/api/orders/price") || ownerPrefixes.some(prefix => pathname.startsWith(prefix));
  // Product previews are shared with merchants, but every purchase surface
  // remains buyer-only. Keep this exception narrow so owner sessions cannot
  // reach cart, address, points, or checkout pages through the buyer shell.
  const sharedBuyerProductDetail = /^\/buyer\/products\/[^/]+$/.test(pathname);
  const buyerPage = pathname === "/buyer" || pathname.startsWith("/buyer/");
  const buyerOnly = buyerPage && !sharedBuyerProductDetail
    || pathname.startsWith("/api/cart")
    || pathname.startsWith("/api/addresses")
    || pathname.startsWith("/api/loyalty");

  if (!role) {
    if (pathname.startsWith("/api/")) return withSecurity(NextResponse.json({ error: "请先登录" }, { status: 401 }));
    // A shared product detail is safe for an owner after authentication, but
    // an unauthenticated visitor is still a buyer-facing flow.
    const login = buyerOnly || buyerPage ? "/buyer/login" : "/admin/login";
    const url = new URL(login, request.url);
    url.searchParams.set("returnTo", `${pathname}${search}`);
    return withSecurity(NextResponse.redirect(url, 307));
  }
  if ((ownerOnly && role !== "owner") || (buyerOnly && role !== "buyer")) {
    if (pathname.startsWith("/api/")) return withSecurity(NextResponse.json({ error: "无权访问" }, { status: 403 }));
    return withSecurity(NextResponse.redirect(new URL(role === "owner" ? "/admin" : "/buyer", request.url), 307));
  }

  return withSecurity(NextResponse.next());
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
