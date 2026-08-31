import { NextResponse } from "next/server";
import db from "@/lib/db";
import { requireApiRole } from "@/lib/auth";
export async function POST(){const auth=await requireApiRole("buyer");if(auth.response)return auth.response;db.prepare("UPDATE users SET tour_completed=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(auth.session.userId);return NextResponse.json({ok:true});}
