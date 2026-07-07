/**
 * Standardized edge-cache header trio for v2 read endpoints.
 *
 * Next.js strips `s-maxage` from dynamic route handlers, so the browser directive
 * (`Cache-Control`) is kept revalidating while the CDN directives carry the real TTL.
 * See commit `3bb3c8d` — this mirrors the trio inlined in feed/profile/balance today.
 */
export const cacheHeaders = (sMaxage: number, swr: number) => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'CDN-Cache-Control': `s-maxage=${sMaxage}, stale-while-revalidate=${swr}`,
  'Vercel-CDN-Cache-Control': `s-maxage=${sMaxage}, stale-while-revalidate=${swr}`,
});
