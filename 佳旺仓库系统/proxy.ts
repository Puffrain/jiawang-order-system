import { NextResponse, type NextRequest } from 'next/server';
import { applyResponseHeaders, assertSameOrigin, getRequestId } from '@/lib/security';

/**
 * App Router proxy hook. It is intentionally stateless: authentication and
 * RBAC remain in each Node route handler, while this layer adds request IDs,
 * browser origin checks and common response headers.
 *
 * Next 16 recognizes this file as the `proxy` convention. For Next versions
 * that still use `middleware.ts`, deployments may re-export `proxy` there.
 */
export function proxy(request: NextRequest): NextResponse {
  const requestId = getRequestId(request);
  const pathname = request.nextUrl.pathname;
  const internal = pathname.startsWith('/warehouse/api/internal/') || pathname.startsWith('/api/internal/');
  if (!internal && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    try {
      assertSameOrigin(request);
    } catch {
      const response = NextResponse.json(
        { error: { code: 'ORIGIN_MISMATCH', message: '不允许的 Origin' }, requestId },
        { status: 403 }
      );
      applyResponseHeaders(response.headers, requestId);
      return response;
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyResponseHeaders(response.headers, requestId);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};

export default proxy;
