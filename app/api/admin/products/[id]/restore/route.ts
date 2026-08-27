import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/audit";
import { requireApiRole } from "@/lib/auth";
import { restoreProduct } from "@/lib/product-catalog";
import { requestIp } from "@/lib/security";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  const { id } = await params;
  const result = restoreProduct(id);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 404 });
  writeAudit({ actorUserId: auth.session.userId, actorRole: "owner", action: "product.restored", objectType: "product", objectId: id, ip: requestIp(request), metadata: { status: result.status, reason: result.reason } });
  return NextResponse.json(result);
}
