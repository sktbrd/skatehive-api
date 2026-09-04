import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { requireSpotmapAdmin } from "@/lib/spotmap-admin";
import { resolveSmallThumbnail } from "@/lib/spotmap-thumbnails";

export const runtime = "nodejs";

// Admin edit for one spotmap_spots row: replace the display image
// (thumbnail_override — the sync jobs never touch this column, so it
// survives the nightly Hive re-sync / KML re-import) and/or fix up
// name/description. Guarded by the same admin rule as the web app's
// spotmap admin panel (skatehive3.0/lib/spotmap/auth.ts requireSpotmapAdmin,
// reproduced in src/lib/spotmap-admin.ts): a valid userbase session whose
// linked Hive identity is in the ADMIN_USERS allow-list.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { success: false, error: "Spot map backend not configured" },
      { status: 500 }
    );
  }

  const admin = await requireSpotmapAdmin(request);
  if (!admin.ok) {
    const status = admin.hiveUsername ? 403 : 401;
    return NextResponse.json({ success: false, error: admin.reason || "Unauthorized" }, { status });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);

  const updates: Record<string, string | null> = {};

  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      return NextResponse.json({ success: false, error: "name cannot be empty" }, { status: 400 });
    }
    updates.name = name;
  }
  if (body?.description !== undefined) {
    updates.description = body.description ? String(body.description).trim() : null;
  }
  if (body?.thumbnail_override !== undefined) {
    updates.thumbnail_override = body.thumbnail_override ? String(body.thumbnail_override).trim() : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
  }

  const { data: updated, error } = await supabaseAdmin
    .from("spotmap_spots")
    .update(updates)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[PATCH /api/admin/spotmap/spot/[id]] update failed", error);
    return NextResponse.json({ success: false, error: "Failed to update spot" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ success: false, error: "Spot not found" }, { status: 404 });
  }

  if ("thumbnail_override" in updates) {
    const small = await resolveSmallThumbnail({
      id: updated.id,
      thumbnail: updated.thumbnail,
      thumbnail_override: updated.thumbnail_override,
      thumbnail_small: updated.thumbnail_small,
    });
    if (small) updated.thumbnail_small = small;
  }

  return NextResponse.json({ success: true, spot: updated });
}
