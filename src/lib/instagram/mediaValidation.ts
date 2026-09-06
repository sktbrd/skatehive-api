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
