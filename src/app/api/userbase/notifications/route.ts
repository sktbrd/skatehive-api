import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { resolveUserbaseUserId } from "@/lib/userbase/session";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/userbase/notifications?limit=&before=
 *
 * The resolved user's own userbase_notifications, newest first. RLS on that
 * table is service-role only (see the web repo's migration 0030), so this
 * route is the only way a client ever reads it — scoped by the session
 * (bearer or cookie via resolveUserbaseUserId), never a client-supplied id.
 */
export async function GET(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ success: false, error: "Userbase backend not configured" }, { status: 500 });
  }

  const userId = await resolveUserbaseUserId(request);
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get("limit")) || DEFAULT_LIMIT));
  const before = searchParams.get("before");

  let query = supabaseAdmin
    .from("userbase_notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) {
    query = query.lt("created_at", before);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[GET /api/userbase/notifications] query failed", error);
    return NextResponse.json({ success: false, error: "Failed to load notifications" }, { status: 500 });
  }

  return NextResponse.json({ success: true, notifications: data ?? [] });
}
