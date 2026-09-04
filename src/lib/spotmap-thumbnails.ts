import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { IMAGE_THUMBNAIL_SERVICE_URL, THUMBNAIL_SHARED_SECRET } from "@/app/api/transcode/config";

// Small (max-400px) thumbnails for spotmap_spots, so the iOS widget doesn't
// have to decode full-size source photos (Google My Maps PNGs up to ~4MB,
// Hive JPEGs ~1MB) against its ~30MB extension memory limit.
//
// Two paths:
//  - Hive-hosted images (images.hive.blog, files.peakd.com): images.hive.blog
//    already resizes for free via a URL path prefix — pure, no network call
//    from here, resolves synchronously.
//  - Everything else (Google My Maps hostedimage URLs, which accept no size
//    parameter and 400 if you add one): queue a background job against the
//    transcoder's POST /image-thumbnail, guarded by the same shared secret
//    as the video-thumbnail work.

const HIVE_CDN_ORIGINS = ["images.hive.blog", "files.peakd.com"];
const CDN_PX = 400;

/** Pure: build a resized images.hive.blog URL, or null if the source isn't Hive-hosted. */
export function buildHiveCdnThumb(url: string, px: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!HIVE_CDN_ORIGINS.includes(parsed.hostname)) return null;
  return `https://images.hive.blog/${px}x${px}/${url}`;
}

export interface SpotmapSpotForThumbnail {
  id: string;
  thumbnail: string | null;
  thumbnail_override?: string | null;
  thumbnail_small?: string | null;
}

const MAX_ATTEMPTS = 3;
// Minimum time since the spot's last attempt before the Nth retry (0-indexed) fires.
const BACKOFF_MS = [0, 60_000, 5 * 60_000];
const REQUEST_TIMEOUT_MS = 65_000;

const inFlight = new Set<string>();
const attemptTracker = new Map<string, { attempts: number; lastAttemptAt: number }>();

async function persistThumbnailSmall(id: string, url: string): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from("spotmap_spots").update({ thumbnail_small: url }).eq("id", id);
  } catch (err) {
    console.error("[spotmap-thumbnails] failed to persist thumbnail_small", id, err);
  }
}

async function requestImageThumbnail(sourceUrl: string): Promise<string | null> {
  if (!IMAGE_THUMBNAIL_SERVICE_URL || !THUMBNAIL_SHARED_SECRET) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(IMAGE_THUMBNAIL_SERVICE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thumbnail-secret": THUMBNAIL_SHARED_SECRET },
      body: JSON.stringify({ url: sourceUrl, maxPx: CDN_PX }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.url || null;
  } catch {
    return null;
  }
}

// Fire-and-forget: dedupes in-flight requests per spot, caps retries, and
// backs off between them. Never awaited by the caller — the transcoder job
// can take up to a minute.
function queueTranscoderJob(spotId: string, sourceUrl: string): void {
  if (inFlight.has(spotId)) return;
  const tracked = attemptTracker.get(spotId);
  const attempts = tracked?.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) return;
  if (tracked) {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    if (Date.now() - tracked.lastAttemptAt < backoff) return;
  }

  inFlight.add(spotId);
  attemptTracker.set(spotId, { attempts: attempts + 1, lastAttemptAt: Date.now() });

  requestImageThumbnail(sourceUrl)
    .then((url) => {
      if (url) return persistThumbnailSmall(spotId, url);
    })
    .catch((err) => console.error("[spotmap-thumbnails] job failed", spotId, err))
    .finally(() => inFlight.delete(spotId));
}

/**
 * Backfill entry point (scripts/backfill-spot-thumbnails.ts): same
 * resolution as resolveSmallThumbnail, but the transcoder call is AWAITED
 * rather than fire-and-forget — the backfill runs sequentially and off-peak,
 * so there's no request to answer quickly and no reason not to wait for the
 * real result.
 */
export async function backfillSpotThumbnail(
  spot: SpotmapSpotForThumbnail
): Promise<{ status: "ready" | "failed" | "skipped"; thumbnailUrl?: string }> {
  const source = spot.thumbnail_override || spot.thumbnail;
  if (!source) return { status: "skipped" };

  const cdn = buildHiveCdnThumb(source, CDN_PX);
  if (cdn) {
    await persistThumbnailSmall(spot.id, cdn);
    return { status: "ready", thumbnailUrl: cdn };
  }

  const tracked = attemptTracker.get(spot.id);
  if ((tracked?.attempts ?? 0) >= MAX_ATTEMPTS) return { status: "skipped" };
  attemptTracker.set(spot.id, { attempts: (tracked?.attempts ?? 0) + 1, lastAttemptAt: Date.now() });

  const url = await requestImageThumbnail(source);
  if (!url) return { status: "failed" };
  await persistThumbnailSmall(spot.id, url);
  return { status: "ready", thumbnailUrl: url };
}

/**
 * Resolve (and persist) thumbnail_small for one spot. NEVER throws — any
 * failure just returns null so the read path falls back to the full-size
 * thumbnail. Hive-hosted origins resolve synchronously (pure URL build, one
 * cheap DB write); other origins queue a background transcoder job and
 * return null until a later call/read picks up the persisted result.
 */
export async function resolveSmallThumbnail(
  spot: SpotmapSpotForThumbnail
): Promise<string | null> {
  try {
    const source = spot.thumbnail_override || spot.thumbnail;
    if (!source) return null;

    const cdn = buildHiveCdnThumb(source, CDN_PX);
    if (cdn) {
      if (spot.thumbnail_small !== cdn) await persistThumbnailSmall(spot.id, cdn);
      return cdn;
    }

    queueTranscoderJob(spot.id, source);
    return null;
  } catch (err) {
    console.error("[spotmap-thumbnails] resolveSmallThumbnail failed", spot.id, err);
    return null;
  }
}
