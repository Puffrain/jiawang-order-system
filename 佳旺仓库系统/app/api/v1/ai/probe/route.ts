import { apiOk, handleApiError } from '@/lib/api';
import { recordAudit } from '@/lib/audit';
import { getDeepSeekConfig, saveDeepSeekCapabilities } from '@/lib/deepseek-config';
import { DeepSeekVisionProvider } from '@/lib/ai/provider';
import { getRequestId, assertSameOrigin, assertCsrfToken, assertJsonContentType } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const config = getDeepSeekConfig();
    const capabilities = config.apiKey && config.baseUrl && config.model
      ? await new DeepSeekVisionProvider({
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        inputFormat: (config.inputFormat as 'data_url' | 'bytes' | 'base64' | 'image_url' | undefined),
        allowedHosts: config.allowedHosts,
        modelsPath: config.modelsPath || undefined,
        chatPath: config.chatPath || undefined,
        timeoutMs: config.timeoutMs || undefined,
        maxTokens: config.maxTokens || undefined,
        visionConfirmed: false,
        requireAllowlist: process.env.NODE_ENV === 'production'
      }).probe()
      : { provider: 'deepseek', available: false, vision: false, acceptsDataUrl: true, model: config.model || undefined, reason: '请先配置 DeepSeek API Key、Base URL 和视觉模型' };
    saveDeepSeekCapabilities(capabilities);
    recordAudit({ requestId, actorUserId: actor.id, action: 'ai.capability_probe', resourceType: 'provider', resourceId: 'deepseek', metadata: { available: capabilities.available, vision: capabilities.vision, model: capabilities.model } });
    return apiOk(capabilities, requestId);
  } catch (error) { return handleApiError(error, requestId); }
}
