import { getPipelineRuntime } from "../../../../lib/jobs/runtime";
import { handlePipelineError, ok, readJson, requestId, requirePipelineRole } from "../../../../lib/jobs/http";
import { createManualCandidateGroup, listCandidateGroups } from "../../../../lib/catalog/pipeline-candidate";
import { recordAudit } from "../../../../lib/audit";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    requirePipelineRole(request, "reviewer");
    const runtime = getPipelineRuntime();
    const jobId = new URL(request.url).searchParams.get('jobId') || undefined;
    const projected = listCandidateGroups(jobId);
    const manual = runtime.store.listGroups();
    return ok({ groups: [...projected.map((group) => ({ ...group, itemIds: group.itemIds })), ...manual] }, id);
  } catch (error) { return handlePipelineError(error, id); }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    const actor = requirePipelineRole(request, "reviewer");
    const body = await readJson(request);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) throw Object.assign(new Error("name is required and must be at most 120 characters"), { code: "GROUP_NAME", class: "validation" });
    if (!Array.isArray(body.itemIds) || !body.itemIds.every((value) => typeof value === "string")) throw Object.assign(new Error("itemIds must be a string array"), { code: "GROUP_ITEMS", class: "validation" });
    const runtime = getPipelineRuntime();
    for (const itemId of body.itemIds) if (!runtime.store.getItem(itemId)) throw Object.assign(new Error(`Unknown item ${itemId}`), { code: "ITEM_NOT_FOUND", class: "validation" });
    // Candidate groups are persisted in the catalogue projection so manual
    // grouping survives a web/worker restart. Keep the file-store fallback
    // for explicit lightweight test deployments.
    const group = process.env.PIPELINE_USE_FILE_STORE === "1"
      ? runtime.store.addGroup(body.name, body.itemIds as string[], typeof body.category === "string" ? body.category.slice(0, 120) : undefined)
      : { ...createManualCandidateGroup(body.name, body.itemIds as string[], typeof body.category === "string" ? body.category.slice(0, 120) : undefined), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    recordAudit({ requestId: id, actorUserId: actor.id, action: 'group.created', resourceType: 'group', resourceId: group.id, metadata: { itemCount: body.itemIds.length } });
    return ok({ group }, id, 201);
  } catch (error) { return handlePipelineError(error, id); }
}
