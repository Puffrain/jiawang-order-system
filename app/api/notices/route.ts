import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { listPublishedNotices } from "@/lib/customer-notices";
export async function GET(){const auth=await requireApiRole("buyer");if(auth.response)return auth.response;return NextResponse.json({notices:listPublishedNotices()},{headers:{"Cache-Control":"private, no-store"}})}
