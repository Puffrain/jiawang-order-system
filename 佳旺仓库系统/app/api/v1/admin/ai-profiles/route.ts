import { apiOk, handleApiError } from '@/lib/api';
import { listAIProfiles, saveAIProfile } from '@/lib/ai-profiles';
import { parseAIProfileInput } from '@/lib/ai-profile-validation';
import { recordAudit } from '@/lib/audit';
import { assertCsrfToken, assertJsonContentType, assertSameOrigin, getRequestId } from '@/lib/security';
import { requireSessionUser } from '@/lib/session';
import { parseJson } from '@/lib/validation';
export const runtime='nodejs'; export const dynamic='force-dynamic';
export async function GET(request:Request){const id=getRequestId(request);try{requireSessionUser(request,'admin');return apiOk({profiles:listAIProfiles()},id);}catch(e){return handleApiError(e,id);}}
export async function POST(request:Request){const id=getRequestId(request);try{assertSameOrigin(request);assertCsrfToken(request);assertJsonContentType(request);const actor=requireSessionUser(request,'admin');const input=parseAIProfileInput(await parseJson(request));const profile=saveAIProfile(input);recordAudit({requestId:id,actorUserId:actor.id,action:'admin.ai_profile_created',resourceType:'ai_profile',resourceId:profile.id,metadata:{provider:profile.provider,revision:profile.revision}});return apiOk({profile},id,201);}catch(e){return handleApiError(e,id);}}
