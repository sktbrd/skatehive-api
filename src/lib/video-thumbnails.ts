import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { THUMBNAIL_SERVICE_URL, THUMBNAIL_SHARED_SECRET } from "@/app/api/transcode/config";
import { extractIPFSHash, type VideoEntry } from "./video-extraction";

// Lazy thumbnail resolver for /api/v2/videos (F3). Chain: metadata/body (done
// upstream, before this runs) -> our own video_thumbnails cache -> Pinata
// keyvalues -> queue a transcoder job and return null (mobile keeps its
// on-device fallback until the row is ready).

const MAX_ATTEMPTS = 3;
// Minimum time since the row's last update before attempt N (0-indexed) is
// allowed to fire again.
const BACKOFF_MS = [0, 60_000, 5 * 60_000];
const PINATA_TIMEOUT_MS = 5000;
const TRANSCODER_TIMEOUT_MS = 65_000;

const pinataCache = new Map<string, { url: string | null; timestamp: number }>();
const PINATA_CACHE_TTL = 30 * 60 * 1000;

// Dedupes concurrent requests for the same CID across overlapping HTTP
// requests to this process (not just within one resolveThumbnails call).
const inFlight = new Set<string>();

type ThumbnailRow = {
  cid: string;
  thumbnail_url: string | null;
  status: "pending" | "ready" | "failed";
  attempts: number;
  updated_at: string;
};

async function fetchThumbnailFromPinata(hash: string): Promise<string | null> {
  const apiKey = process.env.PINATA_API_KEY;
  const apiSecret = process.env.PINATA_SECRET_API_KEY;
  if (!apiKey || !apiSecret) return null;

  const cached = pinataCache.get(hash);
  if (cached && Date.now() - cached.timestamp < PINATA_CACHE_TTL) return cached.url;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PINATA_TIMEOUT_MS);
    const res = await fetch(`https://api.pinata.cloud/data/pinList?hashContains=${hash}&status=pinned`, {
      headers: { pinata_api_key: apiKey, pinata_secret_api_key: apiSecret },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      pinataCache.set(hash, { url: null, timestamp: Date.now() });
      return null;
    }
    const data = await res.json();
    const file = data.rows?.find((f: any) => f.ipfs_pin_hash === hash);
    const url = file?.metadata?.keyvalues?.thumbnailUrl || null;
    pinataCache.set(hash, { url, timestamp: Date.now() });
    return url;
  } catch {
    return null;
  }
}

async function getThumbnailRow(cid: string): Promise<ThumbnailRow | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("video_thumbnails")
    .select("cid, thumbnail_url, status, attempts, updated_at")
    .eq("cid", cid)
    .limit(1);
  return (data?.[0] as ThumbnailRow) || null;
}

async function markReady(cid: string, thumbnailUrl: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("video_thumbnails").upsert(
    { cid, thumbnail_url: thumbnailUrl, status: "ready", source: "transcoder", updated_at: new Date().toISOString() },
    { onConflict: "cid" }
  );
}

async function markFailed(cid: string, lastError: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("video_thumbnails")
    .update({ status: "failed", last_error: lastError, updated_at: new Date().toISOString() })
    .eq("cid", cid);
}

// Fire-and-forget: kicks off the transcoder job but the caller does not wait
// for it (a thumbnail job can take up to a minute).
async function fireTranscoderRequest(cid: string): Promise<void> {
  if (!THUMBNAIL_SERVICE_URL || !THUMBNAIL_SHARED_SECRET) {
    await markFailed(cid, "thumbnail service not configured");
    return;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRANSCODER_TIMEOUT_MS);
    const res = await fetch(THUMBNAIL_SERVICE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thumbnail-secret": THUMBNAIL_SHARED_SECRET },
      body: JSON.stringify({ cid }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      await markFailed(cid, `transcoder responded ${res.status}`);
      return;
    }
    const json = await res.json().catch(() => null);
    if (json?.thumbnailUrl) {
      await markReady(cid, json.thumbnailUrl);
    } else {
      await markFailed(cid, "transcoder response missing thumbnailUrl");
    }
  } catch (err: any) {
    await markFailed(cid, err?.message || "request failed");
  }
}

// Awaits only the (fast) pending-row bookkeeping; the transcoder round trip
// itself runs in the background.
async function queueTranscoderJob(cid: string, row: ThumbnailRow | null): Promise<void> {
  if (inFlight.has(cid)) return;
  const attempts = row?.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) return;
  if (row) {
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    if (Date.now() - new Date(row.updated_at).getTime() < backoff) return;
  }

  inFlight.add(cid);
  if (supabaseAdmin) {
    await supabaseAdmin.from("video_thumbnails").upsert(
      { cid, status: "pending", attempts: attempts + 1, source: "transcoder", updated_at: new Date().toISOString() },
      { onConflict: "cid" }
    );
  }
  fireTranscoderRequest(cid).finally(() => inFlight.delete(cid));
}

/**
 * Backfill entry point (scripts/backfill-thumbnails.ts): same resolution
 * chain as resolveThumbnails, but the transcoder call is AWAITED rather than
 * fire-and-forget, since the backfill runs sequentially and off-peak — a
 * script run has no request to answer quickly, so there's no reason not to
 * wait for the real result.
 */
export async function backfillThumbnail(
  cid: string
): Promise<{ status: "ready" | "failed" | "skipped"; thumbnailUrl?: string }> {
  const row = await getThumbnailRow(cid);
  if (row?.status === "ready" && row.thumbnail_url) {
    return { status: "ready", thumbnailUrl: row.thumbnail_url };
  }
  if ((row?.attempts ?? 0) >= MAX_ATTEMPTS) {
    return { status: "skipped" };
  }

  const pinataUrl = await fetchThumbnailFromPinata(cid);
  if (pinataUrl) {
    await markReady(cid, pinataUrl);
    return { status: "ready", thumbnailUrl: pinataUrl };
  }

  if (!THUMBNAIL_SERVICE_URL || !THUMBNAIL_SHARED_SECRET) {
    return { status: "skipped" };
  }

  const attempts = (row?.attempts ?? 0) + 1;
  if (supabaseAdmin) {
    await supabaseAdmin.from("video_thumbnails").upsert(
      { cid, status: "pending", attempts, source: "transcoder", updated_at: new Date().toISOString() },
      { onConflict: "cid" }
    );
  }
  await fireTranscoderRequest(cid);

  const finalRow = await getThumbnailRow(cid);
  if (finalRow?.status === "ready" && finalRow.thumbnail_url) {
    return { status: "ready", thumbnailUrl: finalRow.thumbnail_url };
  }
  return { status: "failed" };
}

export async function resolveThumbnails(videos: VideoEntry[]): Promise<VideoEntry[]> {
  const result = [...videos];
  const missing = result
    .map((v, i) => ({ i, hash: v.thumbnailUrl ? null : extractIPFSHash(v.videoUrl) }))
    .filter((e): e is { i: number; hash: string } => Boolean(e.hash));

  if (missing.length === 0) return result;

  const uniqueHashes = Array.from(new Set(missing.map((e) => e.hash)));
  const resolved = new Map<string, string | null>();

  await Promise.all(
    uniqueHashes.map(async (cid) => {
      const row = await getThumbnailRow(cid);
      if (row?.status === "ready" && row.thumbnail_url) {
        resolved.set(cid, row.thumbnail_url);
        return;
      }

      const pinataUrl = await fetchThumbnailFromPinata(cid);
      if (pinataUrl) {
        resolved.set(cid, pinataUrl);
        return;
      }

      resolved.set(cid, null);
      await queueTranscoderJob(cid, row);
    })
  );

  for (const { i, hash } of missing) {
    result[i] = { ...result[i], thumbnailUrl: resolved.get(hash) ?? null };
  }
  return result;
}
