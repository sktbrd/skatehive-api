import { resolveUserbaseUserId, getPrimaryHiveHandle } from "@/lib/userbase/session";

// Ported from skatehive3.0's lib/spotmap/auth.ts (requireSpotmapAdmin): a
// caller is a spotmap admin iff they have a valid userbase session whose
// linked (primary) Hive identity's handle is in the ADMIN_USERS allow-list.
// We deliberately never trust a username sent in the request body — it has
// to come from a verified linked identity row.
//
// One deliberate difference from the web version: web's query just takes
// whichever hive identity row comes back first (no ordering); we use
// getPrimaryHiveHandle, which orders by is_primary desc — the same
// resolver every other admin-adjacent check in this repo already uses.
// And the session itself is read via resolveUserbaseUserId (dual
// transport: Authorization Bearer OR the userbase_refresh cookie) rather
// than the web app's cookie-only read, since mobile calls this API with a
// bearer token.

const ADMIN_USERS = (process.env.ADMIN_USERS || process.env.NEXT_PUBLIC_ADMIN_USERS || "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

export function isServerSideAdmin(username: string | null | undefined): boolean {
  if (!username) return false;
  return ADMIN_USERS.includes(username.toLowerCase());
}

export interface SpotmapAdminCheckResult {
  ok: boolean;
  hiveUsername: string | null;
  reason?: string;
}

export async function requireSpotmapAdmin(req: Request): Promise<SpotmapAdminCheckResult> {
  const userId = await resolveUserbaseUserId(req);
  if (!userId) {
    return { ok: false, hiveUsername: null, reason: "No session" };
  }

  const hiveUsername = await getPrimaryHiveHandle(userId);
  if (!hiveUsername) {
    return { ok: false, hiveUsername: null, reason: "No linked Hive identity" };
  }

  if (!isServerSideAdmin(hiveUsername)) {
    return { ok: false, hiveUsername, reason: "Not in admin allow-list" };
  }

  return { ok: true, hiveUsername };
}
