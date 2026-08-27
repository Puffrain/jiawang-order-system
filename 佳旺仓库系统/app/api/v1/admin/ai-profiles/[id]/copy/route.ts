import { apiOk, handleApiError } from '@/lib/api';
import { copyAIProfile } from '@/lib/ai-profiles';
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
    const sourceId = (await params).id;
    const profile = copyAIProfile(sourceId);
    recordAudit({ requestId, actorUserId: actor.id, action: 'admin.ai_profile_copied', resourceType: 'ai_profile', resourceId: profile.id, metadata: { sourceId, provider: profile.provider, revision: profile.revision } });
    return apiOk({ profile }, requestId, 201);
  } catch (error) {
    return handleApiError(error, requestId);
  }
}
