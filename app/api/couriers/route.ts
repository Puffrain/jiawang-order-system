import { NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import db from "@/lib/db";
export async function GET(){const auth=await requireApiRole("owner");if(auth.response)return auth.response;const couriers=db.prepare("SELECT id,display_name displayName,phone FROM users WHERE role=\"courier\" AND status=\"active\" ORDER BY display_name,phone").all();return NextResponse.json({couriers});}
