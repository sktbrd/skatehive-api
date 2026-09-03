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

export function recordAttempt(key: string, windowMs: number): void {
  const now = Date.now();
  const w = store.get(key);
  if (!w || now > w.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    w.count += 1;
  }
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
