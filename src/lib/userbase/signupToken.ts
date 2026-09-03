import crypto from "crypto";

// Short-lived HMAC token proving an email was just OTP-verified, so the
// follow-up "choose username + create account" call is authorized without
// re-sending the code. Stateless (no DB row) — payload + HMAC signature.

const TTL_MINUTES = 15;

function secret(): string {
  const s =
    process.env.USERBASE_INTERNAL_TOKEN ||
    process.env.USERBASE_KEY_ENCRYPTION_SECRET;
  if (!s) throw new Error("Signup token secret not configured");
  return s;
}

export function signSignupToken(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ email: email.toLowerCase(), exp: Date.now() + TTL_MINUTES * 60 * 1000 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// Consumption tracking (opt-in — signup/complete does not use this, it's
// intentionally idempotent on double-submit). signup/claim marks a token
// consumed once it has successfully attached the email to a Hive account, so
// the same token can't mint a second session for a different handle/key.
// In-memory only, same caveat as the rate limiter: per-process, not shared
// across concurrent serverless instances.
const consumedTokens = new Map<string, number>(); // sha256(token) -> expiresAt

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function purgeConsumed(now: number): void {
  for (const [hash, expiresAt] of consumedTokens) {
    if (now > expiresAt) consumedTokens.delete(hash);
  }
}

export function isSignupTokenConsumed(token: string): boolean {
  purgeConsumed(Date.now());
  return consumedTokens.has(tokenHash(token));
}

export function markSignupTokenConsumed(token: string): void {
  const now = Date.now();
  purgeConsumed(now);
  // Only needs to outlive the token's own TTL — once the token itself would
  // fail verification on expiry, there's nothing left to protect against.
  consumedTokens.set(tokenHash(token), now + TTL_MINUTES * 60 * 1000);
}

export function verifySignupToken(token: string): { email: string } | null {
  const parts = (token || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!email || typeof exp !== "number" || exp < Date.now()) return null;
    return { email };
  } catch {
    return null;
  }
}
