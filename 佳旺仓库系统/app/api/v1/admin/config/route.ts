import { apiOk, handleApiError } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { getPublicDeepSeekConfig, saveDeepSeekConfig } from '@/lib/deepseek-config';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseDeepSeekConfigInput, parseJson } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    requireSessionUser(request, 'admin');
    return apiOk({ config: getPublicDeepSeekConfig() }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}

export async function PUT(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const input = parseDeepSeekConfigInput(await parseJson(request));
    const config = saveDeepSeekConfig(input);
    recordAudit({
      requestId,
      actorUserId: actor.id,
      action: 'admin.deepseek_config_updated',
      resourceType: 'app_setting',
      resourceId: 'deepseek.config',
      metadata: {
        baseUrl: input.baseUrl,
        model: input.model,
        inputFormat: input.inputFormat,
        apiKeyChanged: input.apiKey !== undefined && input.apiKey !== ''
      }
    });
    return apiOk({ config }, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
