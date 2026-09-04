// Validates media URLs before this service asks Meta (or itself) to fetch
// them, so /api/instagram/post can't be used as an open SSRF-ish fetch proxy
// for arbitrary URLs. Split out of route.ts because Next's route-file type
// checker only allows HTTP-method exports from a route.ts.

// Every IPFS/CDN gateway this repo already serves Hive media from
// (see src/app/api/v2/ipfs/upload/route.ts, video-extraction.ts) plus
// images.hive.blog/files.peakd.com, the two Hive-image CDNs. Extend by
// adding a host here if a new gateway is introduced.
const INSTAGRAM_MEDIA_ALLOWED_HOSTS = [
  "images.hive.blog",
  "files.peakd.com",
  "ipfs.skatehive.app",
  "gateway.pinata.cloud",
];

/** Pure: https only, hostname on the allow-list. */
export function isAllowedInstagramMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return INSTAGRAM_MEDIA_ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase());
}

const PROBE_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 4000;
const MAX_ATTEMPTS = 3;

/**
 * Verify Meta will actually be able to fetch the media before we ask it to.
 * IPFS gateways sometimes serve a not-yet-/never-pinned CID as a non-media 4xx,
 * which Meta surfaces as the opaque "Media could not be fetched" (2207077).
 * HEAD-probe the URL (a few times, to ride out genuine propagation lag) and
 * require a 2xx image/* or video/* response. Returns true if reachable.
 *
 * redirect: 'manual' — a redirect target hasn't itself been checked against
 * the allow-list, so a 3xx is treated as a failure rather than followed.
 * Each attempt gets its own 5s timeout via AbortController.
 */
export async function mediaIsFetchable(url: string): Promise<boolean> {
  // FAIL-OPEN: only return false on a CONFIRMED non-media 4xx (the broken-CID
  // case) or a redirect. On network errors/timeouts/5xx we proceed and let
  // Meta try, so we never falsely block a real publish if our own egress
  // can't reach the gateway.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let status = 0;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let res: { ok: boolean; status: number; type: string; headers: { get(name: string): string | null } };
      try {
        res = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        status = res.status || 302;
      } else {
        const type = (res.headers.get("content-type") || "").toLowerCase();
        if (res.ok && (type.startsWith("video/") || type.startsWith("image/"))) return true;
        status = res.status;
      }
    } catch {
      return true; // can't probe — don't block; let Meta be the judge
    }
    if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    else if (status >= 300 && status < 500) return false; // gateway says the CID isn't valid, or redirected somewhere unvalidated
  }
  return true;
}
