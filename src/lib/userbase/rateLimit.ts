// In-memory, best-effort rate limiter for auth endpoints. Scoped to a single
// Node process, so it resets on redeploy and is not shared across concurrent
// Vercel serverless instances — good enough as a first line of defense against
// scripted brute-forcing; upgrade to a DB/Redis-backed limiter if abuse proves
// otherwise.

type Window = { count: number; resetAt: number };

const store = new Map<string, Window>();

export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const w = store.get(key);
  if (!w || Date.now() > w.resetAt) return false;
  return w.count >= limit;
}

function purgeExpired(now: number): void {
  for (const [key, w] of store) {
    if (now > w.resetAt) store.delete(key);
  }
}

export function recordAttempt(key: string, windowMs: number): void {
  const now = Date.now();
  purgeExpired(now); // keep the map bounded — it otherwise only ever grows
  const w = store.get(key);
  if (!w || now > w.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    w.count += 1;
  }
}

// x-real-ip is the single header Vercel itself sets to the connecting
// client's address. x-forwarded-for is client-suppliable (a caller can send
// any value as its first hop) so it isn't trustworthy as a rate-limit key.
export function getClientIp(req: Request): string {
  return req.headers.get("x-real-ip") || "unknown";
}
