import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { resolveUserbaseUserId } from "@/lib/userbase/session";

export const runtime = "nodejs";

/**
 * POST /api/userbase/notifications/read {ids?: string[], all?: boolean}
 *
 * Marks notifications read for the resolved user. The update is ALWAYS
 * scoped by `.eq("user_id", userId)` in addition to any id filter — a
 * client-supplied id can never mark someone else's notification read, since
 * the WHERE clause requires both to match.
 */
export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "Userbase backend not configured" }, { status: 500 });
  }

  const userId = await resolveUserbaseUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const all = body?.all === true;
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === "string")
    : [];

  if (!all && ids.length === 0) {
    return NextResponse.json({ success: false, error: "Provide ids or all: true" }, { status: 400 });
  }

  let query = supabaseAdmin
    .from("userbase_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (!all) {
    query = query.in("id", ids);
  }

  const { error } = await query;
  if (error) {
    console.error("[POST /api/userbase/notifications/read] update failed", error);
    return NextResponse.json({ success: false, error: "Failed to mark notifications read" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
