import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { listProducts } from "@/lib/product-catalog";

export async function GET() {
  const auth = await requireApiRole("owner");
  if (auth.response) return auth.response;
  return NextResponse.json({ products: listProducts("owner", { scope: "archived" }) }, { headers: { "Cache-Control": "no-store" } });
}
