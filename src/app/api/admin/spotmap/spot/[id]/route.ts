import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { requireSpotmapAdmin } from "@/lib/spotmap-admin";
import { isAllowedThumbnailSourceHost, resolveSmallThumbnail } from "@/lib/spotmap-thumbnails";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_THUMBNAIL_URL_LENGTH = 2048;

// Same message for every admin-check failure that isn't "no session at all"
// — don't let the response distinguish "authenticated but no linked Hive
// identity" from "linked but not on the allow-list", which would leak setup
// details to someone probing for admin access.
const FORBIDDEN_MESSAGE = "Admin access required";

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
    // 401 only for "not authenticated at all"; everything past that (no
    // linked Hive identity, not on the allow-list) is 403 with the SAME
    // generic message — an authenticated non-admin shouldn't learn which
    // specific check they failed.
    if (admin.reason === "No session") {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ success: false, error: FORBIDDEN_MESSAGE }, { status: 403 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: "Invalid spot id" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const updates: Record<string, string | null> = {};

  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      return NextResponse.json({ success: false, error: "name cannot be empty" }, { status: 400 });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ success: false, error: `name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 400 });
    }
    updates.name = name;
  }

  if (body?.description !== undefined) {
    const description = body.description ? String(body.description).trim() : null;
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        { success: false, error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }
    updates.description = description;
  }

  if (body?.thumbnail_override !== undefined) {
    if (body.thumbnail_override === null || body.thumbnail_override === "") {
      updates.thumbnail_override = null;
    } else {
      const url = String(body.thumbnail_override).trim();
      if (url.length > MAX_THUMBNAIL_URL_LENGTH || !isAllowedThumbnailSourceHost(url)) {
        return NextResponse.json(
          { success: false, error: "thumbnail_override must be an https URL on the allowed image hosts" },
          { status: 400 }
        );
      }
      updates.thumbnail_override = url;
    }
    // A changed (or cleared) override invalidates whatever's cached — never
    // serve a stale small image while regeneration runs, and GET's own
    // lazy-generation path picks this row back up if regeneration below
    // doesn't resolve synchronously (the transcoder path).
    updates.thumbnail_small = null;
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
