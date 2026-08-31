import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
import { getLoyaltySummary } from "@/lib/loyalty";

export async function GET(request: Request) {
  const auth = await requireApiRole("buyer");
  if (auth.response) return auth.response;
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Number.isSafeInteger(requestedLimit) ? requestedLimit : 50;
  return NextResponse.json({ loyalty: getLoyaltySummary(db, auth.session.userId, limit) }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
