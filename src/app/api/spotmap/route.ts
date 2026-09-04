import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { resolveSmallThumbnail } from "@/lib/spotmap-thumbnails";

interface SpotRow {
  id: string;
  source: string;
  source_id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  thumbnail: string | null;
  thumbnail_override: string | null;
  thumbnail_small: string | null;
  hive_author: string | null;
  hive_permlink: string | null;
  hive_created: string | null;
  kml_description: string | null;
}

// Public read endpoint for the synced skate-spot map. Mirrored from the
// skatehive3.0 web app onto api.skatehive.app so the mobile app no longer
// depends on the website's Vercel firewall posture (Attack Challenge Mode on
// skatehive.app was serving a JS challenge to the app's fetch). One query, no
// pagination — the map wants everything at once. Same Supabase project as the
// userbase tables (see supabaseAdmin), which is where spotmap_spots lives.
export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { success: false, error: "Spot map backend not configured" },
      { status: 500 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("spotmap_spots")
    .select(
      "id, source, source_id, name, lat, lng, address, thumbnail, " +
        "thumbnail_override, thumbnail_small, " +
        "hive_author, hive_permlink, hive_created, kml_description"
    )
    .order("hive_created", { ascending: false, nullsFirst: false })
    .limit(10000)
    .returns<SpotRow[]>();

  if (error) {
    console.error("[GET /api/spotmap] query failed", error);
    return NextResponse.json(
      { success: false, error: "Failed to load spots" },
      { status: 500 }
    );
  }

  const rows = data ?? [];
  const spots = rows.map(({ thumbnail_override, thumbnail_small, ...rest }) => {
    const coalescedThumbnail = thumbnail_override || rest.thumbnail;
    return {
      ...rest,
      thumbnail: coalescedThumbnail,
      thumbnail_small: thumbnail_small || coalescedThumbnail,
    };
  });

  // Lazily (never awaited — resolveSmallThumbnail itself never throws)
  // queue generation for rows the DB doesn't have a small thumbnail for yet,
  // so a later request serves the cached version instead of the fallback.
  for (const row of rows) {
    if (!row.thumbnail_small) {
      void resolveSmallThumbnail({
        id: row.id,
        thumbnail: row.thumbnail,
        thumbnail_override: row.thumbnail_override,
        thumbnail_small: row.thumbnail_small,
      });
    }
  }

  return NextResponse.json(
    { success: true, count: spots.length, spots },
    {
      headers: {
        // Edge-cache — sync is manual so freshness pressure is low.
        "Cache-Control":
          "public, max-age=120, s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
