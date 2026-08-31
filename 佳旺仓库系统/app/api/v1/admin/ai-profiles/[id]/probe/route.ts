import { apiOk, handleApiError } from '@/lib/api';
import { DeepSeekVisionProvider } from '@/lib/ai/provider';
import { getAIProfileSecret, saveAIProfileProbe } from '@/lib/ai-profiles';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = getRequestId(request);
  try {
    assertSameOrigin(request);
    assertCsrfToken(request);
    assertJsonContentType(request);
    const actor = requireSessionUser(request, 'admin');
    const id = (await params).id;
    const profile = getAIProfileSecret(id);
    const config = profile.config;
    const result = await new DeepSeekVisionProvider({
      baseUrl: config.baseUrl,
      model: config.model,
      textModel: config.textModel,
      apiKey: config.apiKey,
      modelsPath: config.modelsPath,
      chatPath: config.chatPath,
      inputFormat: config.inputFormat,
      allowedHosts: config.allowedHosts,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      requireAllowlist: process.env.NODE_ENV === 'production',
    }, profile.provider).probe();
    saveAIProfileProbe(id, result);
    recordAudit({ requestId, actorUserId: actor.id, action: 'admin.ai_profile_probed', resourceType: 'ai_profile', resourceId: id, metadata: { provider: profile.provider, revision: profile.revision, available: result.available, vision: result.vision, model: result.model } });
    return apiOk(result, requestId);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
