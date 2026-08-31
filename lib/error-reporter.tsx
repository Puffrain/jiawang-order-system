"use client";

import { useEffect } from "react";

/**
 * 客户端错误自动上报组件 (脚手架平台埋点, 不要删).
 *
 * 把浏览器侧的 4 类错误统一 POST 到 ``/api/luffy-platform-error``, 后端写入
 * ``/tmp/preview.log`` 跟 next dev 输出混合, 让 code-agent 的 inspect_runtime
 * 能在用户下一次发消息时自动看到, 主动修代码 (用户不需要复制控制台).
 *
 * 监听:
 *   1. ``window.error`` — 未捕获 JS 错误
 *   2. ``unhandledrejection`` — 未处理 Promise rejection
 *   3. ``fetch`` 响应 5xx — 服务端异常 (4xx 是业务码, 不上报防噪音)
 *   4. 应用主动调 ``reportClientError()`` — 业务捕获后想暴露给 LLM 的事件
 *
 * 在 ``app/layout.tsx`` 顶层 mount 一次即可.
 */
export function ErrorReporter() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as unknown as { __luffyErrorReporterMounted?: boolean }).__luffyErrorReporterMounted) {
      return;
    }
    (window as unknown as { __luffyErrorReporterMounted?: boolean }).__luffyErrorReporterMounted = true;

    const onError = (event: ErrorEvent) => {
      void postError({
        kind: "window.error",
        message: event.message,
        stack: appendDiagnosticContext(event.error?.stack ?? null),
        location: `${event.filename}:${event.lineno}:${event.colno}`,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      void postError({
        kind: "unhandled.rejection",
        message:
          reason instanceof Error ? reason.message : String(reason ?? "(no reason)"),
        stack: appendDiagnosticContext(reason instanceof Error ? reason.stack ?? null : null),
        location: window.location.pathname,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const resp = await originalFetch(...args);
      if (resp.status >= 500 && !isReportPath(args[0])) {
        const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
        const init = args[1];
        const method = (init?.method || "GET").toUpperCase();
        let bodyPreview = "";
        try {
          bodyPreview = (await resp.clone().text()).slice(0, 500);
        } catch {
          // 忽略 body 读取失败
        }
        void postError({
          kind: "fetch.5xx",
          message: `${method} ${url} → ${resp.status}`,
          stack: bodyPreview,
          location: window.location.pathname,
        });
      }
      return resp;
    };

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.fetch = originalFetch;
      delete (window as unknown as { __luffyErrorReporterMounted?: boolean }).__luffyErrorReporterMounted;
    };
  }, []);

  return null;
}

interface ClientErrorPayload {
  kind: string;
  message: string;
  stack: string | null;
  location: string;
}

function isReportPath(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  return url.includes("/api/luffy-platform-error");
}

async function postError(payload: ClientErrorPayload): Promise<void> {
  try {
    await fetch("/api/luffy-platform-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        timestamp: new Date().toISOString(),
      }),
      keepalive: true,
    });
  } catch {
    // 上报本身失败不能再触发上报死循环, 静默吞
  }
}

function appendDiagnosticContext(stack: string | null): string {
  if (typeof window === "undefined") return stack ?? "";
  const navigation = performance.getEntriesByType("navigation").at(-1) as PerformanceNavigationTiming | undefined;
  const resources = performance.getEntriesByType("resource").slice(-8).map(entry => {
    const resource = entry as PerformanceResourceTiming;
    return { name: resource.name, initiatorType: resource.initiatorType, duration: Math.round(resource.duration), transferSize: resource.transferSize };
  });
  const context = JSON.stringify({
    documentUrl: window.location.href,
    readyState: document.readyState,
    visibility: document.visibilityState,
    navigationType: navigation?.type ?? "unknown",
    recentResources: resources,
  });
  return `${stack ?? ""}\n[diagnostic-context] ${context}`.trim();
}

/**
 * 业务代码主动上报错误 (catch block 里有意暴露给 LLM 的场景).
 *
 * 用法:
 *
 *   try {
 *     await doRiskyThing();
 *   } catch (e) {
 *     reportClientError("doRiskyThing 失败", e);
 *     throw e;
 *   }
 */
export function reportClientError(message: string, error?: unknown): void {
  if (typeof window === "undefined") return;
  void postError({
    kind: "manual.report",
    message,
    stack: error instanceof Error ? error.stack ?? error.message : String(error ?? ""),
    location: window.location.pathname,
  });
}
