import { NextRequest, NextResponse } from "next/server";
import { appendFileSync } from "node:fs";

/**
 * 客户端错误收集端点 (脚手架平台埋点, 不要改路径 / 不要删).
 *
 * lib/error-reporter.tsx 把浏览器错 POST 到这里, 这里把它格式化追加到
 * /tmp/client-errors.log (独立文件; next dev stdout 直接 shell 重定向 /tmp/preview.log
 * 不是 O_APPEND, 跟本路由 appendFileSync 同写会 race 截断). 平台 inspect_runtime
 * 节点会同时读这两份文件.
 *
 * 设计:
 *   - 任何异常都吞 (绝不 throw / 返 5xx), 否则 ErrorReporter 又会捕获到
 *     这条 5xx 形成死循环.
 *   - 返 204 No Content, 不让前端再做任何处理.
 *   - body 限制大小 (最多 8KB), 防止恶意巨大 payload 撑爆 log.
 */
const CLIENT_ERROR_LOG_PATH = "/tmp/client-errors.log";
const MAX_BODY_BYTES = 8 * 1024;

interface ClientErrorBody {
  kind?: string;
  message?: string;
  stack?: string | null;
  location?: string;
  userAgent?: string;
  timestamp?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const raw = await req.text();
    const trimmed = raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw;
    const data = (JSON.parse(trimmed) ?? {}) as ClientErrorBody;
    const line =
      `[client-error] ${data.timestamp ?? new Date().toISOString()} ` +
      `kind=${data.kind ?? "?"} ` +
      `at=${data.location ?? "?"} | ` +
      `${data.message ?? "(no message)"}` +
      (data.stack ? `\n${data.stack}` : "") +
      "\n";
    appendFileSync(CLIENT_ERROR_LOG_PATH, line);
  } catch {
    // 任何错误都不暴露给前端 (会引发上报死循环).
  }
  return new NextResponse(null, { status: 204 });
}
