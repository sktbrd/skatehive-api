/**
 * Cross-post review queue.
 *
 * Ported from skatehive3.0/lib/crosspost/queue.ts — same table, same column
 * names, same status values. skatehive-api ONLY enqueues (see
 * src/app/api/instagram/post/route.ts); the publisher
 * (lib/crosspost/publishQueueItem.ts) is web-only and deliberately NOT
 * ported here — this service must never call the Instagram Graph API.
 *
 * An Instagram cross-post is ENQUEUED here instead of published immediately.
 * The curation team reviews it in the SkateHive portal, which decides if and
 * when it ships. Farcaster is not a curated target — see CURATED_TARGETS.
 *
 * Shape of the flow:
 *
 *   mobile ──▶ /api/instagram/post ──▶ enqueueCrossPost() → pending_review
 *                                                  │
 *                         Portal reads the table ──┤  (PostgREST, direct)
 *                         Portal publishes to IG ──┤
 *                         Portal writes the outcome┘
 *
 * There is no HTTP API here for the portal to drive — the TABLE is the
 * contract. See the web repo's docs/CROSSPOST_QUEUE.md for the columns it
 * reads and writes.
 *
 * The payload stored on the row is the FULLY NORMALIZED publish input
 * (caption already built, media URLs already validated), so whoever
 * publishes is a dumb executor and never re-derives content.
 */
export const CROSSPOST_QUEUE_TABLE = "userbase_crosspost_queue";

/**
 * Targets the curation queue actually covers. Instagram only — see the web
 * repo's queue.ts for why Farcaster isn't curated. This service never casts
 * to Farcaster at all, so CURATED_TARGETS only matters here for
 * isCrossPostQueueEnabled's target guard.
 */
export const CURATED_TARGETS: CrossPostTarget[] = ["instagram"];

/**
 * Web's kill switch for the whole curation queue — see the web repo's
 * queue.ts for the full rationale (CROSSPOST_QUEUE_ENABLED unset/"false" →
 * publish immediately; "true" → everyone queued; "alice,bob" → canary by
 * Hive handle).
 *
 * skatehive-api does NOT read this flag: mobile never publishes inline, by
 * design (see instagram-moderation-design), so every cross-post request from
 * this service is enqueued regardless of what CROSSPOST_QUEUE_ENABLED says.
 * The flag only ever affects skatehive3.0's own route. This function is
 * ported anyway (a) for parity/documentation, and (b) in case a future
 * feature here needs the same target-gating logic — it is deliberately NOT
 * called from the instagram/post route.
 */
export function isCrossPostQueueEnabled(
  hiveHandle: string | null,
  target: CrossPostTarget = "instagram"
): boolean {
  if (!CURATED_TARGETS.includes(target)) return false;

  const raw = (process.env.CROSSPOST_QUEUE_ENABLED || "").trim();
  if (!raw || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;

  const allowed = raw
    .split(",")
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  if (!hiveHandle) return false;
  return allowed.includes(hiveHandle.trim().replace(/^@/, "").toLowerCase());
}

export type CrossPostTarget = "instagram" | "farcaster";

export type CrossPostQueueStatus =
  | "pending_review"
  | "approved"
  | "publishing"
  | "published"
  | "rejected"
  | "failed";

/** Statuses that hold the (target, author, permlink) slot — see the partial
 *  unique index in the web repo's migration 0029. A rejected/failed item
 *  frees the slot. */
export const ACTIVE_QUEUE_STATUSES: CrossPostQueueStatus[] = [
  "pending_review",
  "approved",
  "publishing",
  "published",
];

/** Publish input for an Instagram queue item. Mirrors what the web's
 *  graph.ts needs — this service builds the same shape but never calls it. */
export interface InstagramQueuePayload {
  caption: string;
  collaborators: string[];
  image_url: string | null;
  video_url: string | null;
  /** Ordered carousel items — 2+ means CAROUSEL. Unused by mobile today. */
  media_items?: { type: "image" | "video"; url: string }[];
  ig_media_type: "IMAGE" | "REELS" | "CAROUSEL";
  /** Context for the portal UI (not used by the publisher). */
  permalink_url: string;
  title?: string;
  tags?: string[];
  /** Set when a moderator force-queued someone else's snap. */
  forced_by?: string;
}

/** Publish input for a Farcaster queue item. Not used by this service today
 *  (Farcaster isn't curated) — ported for type parity with the web repo. */
export interface FarcasterQueuePayload {
  text: string;
  embeds: { url: string }[];
  channel_id: string | null;
  /** Context for the portal UI. */
  permalink_url?: string;
}

export type CrossPostQueuePayload = InstagramQueuePayload | FarcasterQueuePayload;

export interface CrossPostQueueRow {
  id: string;
  user_id: string | null;
  requested_by_handle: string | null;
  target: CrossPostTarget;
  hive_author: string | null;
  hive_permlink: string | null;
  status: CrossPostQueueStatus;
  payload: CrossPostQueuePayload;
  reviewed_by_handle: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  attempts: number;
  published_at: string | null;
  publish_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueCrossPostInput {
  supabase: any;
  target: CrossPostTarget;
  userId: string | null;
  requestedByHandle: string | null;
  hiveAuthor: string | null;
  hivePermlink: string | null;
  payload: CrossPostQueuePayload;
}

export type EnqueueResult =
  | { ok: true; id: string; duplicate?: undefined }
  | { ok: true; id: string; duplicate: CrossPostQueueRow }
  | { ok: false; status: number; error: string };

/**
 * Insert a pending_review item.
 *
 * If an ACTIVE item already exists for the same (target, author, permlink) we
 * return it as `duplicate` instead of erroring — the caller turns that into a
 * friendly "already waiting for review / already published" response. A
 * previously rejected or failed item does not block a new request.
 */
export async function enqueueCrossPost(
  input: EnqueueCrossPostInput
): Promise<EnqueueResult> {
  const { supabase } = input;
  if (!supabase) {
    return { ok: false, status: 500, error: "Server is missing Supabase config." };
  }

  // Pre-check so the common case returns a useful message instead of a raw
  // unique-violation. The index is still the authority (race → 23505 below).
  if (input.hiveAuthor && input.hivePermlink) {
    const existing = await findActiveQueueItem({
      supabase,
      target: input.target,
      hiveAuthor: input.hiveAuthor,
      hivePermlink: input.hivePermlink,
    });
    if (existing) return { ok: true, id: existing.id, duplicate: existing };
  }

  const { data, error } = await supabase
    .from(CROSSPOST_QUEUE_TABLE)
    .insert({
      user_id: input.userId,
      requested_by_handle: input.requestedByHandle,
      target: input.target,
      hive_author: input.hiveAuthor,
      hive_permlink: input.hivePermlink,
      status: "pending_review",
      payload: input.payload,
    })
    .select("id")
    .single();

  if (error || !data) {
    // 23505 = another request enqueued the same snap between our check and
    // this insert. Re-read and treat it as a duplicate, not a failure.
    if ((error as any)?.code === "23505" && input.hiveAuthor && input.hivePermlink) {
      const existing = await findActiveQueueItem({
        supabase,
        target: input.target,
        hiveAuthor: input.hiveAuthor,
        hivePermlink: input.hivePermlink,
      });
      if (existing) return { ok: true, id: existing.id, duplicate: existing };
    }
    return {
      ok: false,
      status: 500,
      error: error?.message || "Failed to queue cross-post for review.",
    };
  }

  return { ok: true, id: data.id as string };
}

/**
 * Deliberately returns null on a query error instead of throwing.
 *
 * This is a convenience lookup, not the guard: the partial unique index is
 * what actually prevents a duplicate. If this read fails transiently, falling
 * through to the insert is the correct outcome — the index either accepts the
 * row or raises 23505, which enqueueCrossPost already handles. Throwing here
 * would turn a recoverable read blip into a 500 for the user.
 */
export async function findActiveQueueItem(args: {
  supabase: any;
  target: CrossPostTarget;
  hiveAuthor: string;
  hivePermlink: string;
}): Promise<CrossPostQueueRow | null> {
  const { data } = await args.supabase
    .from(CROSSPOST_QUEUE_TABLE)
    .select("*")
    .eq("target", args.target)
    .eq("hive_author", args.hiveAuthor)
    .eq("hive_permlink", args.hivePermlink)
    .in("status", ACTIVE_QUEUE_STATUSES)
    .limit(1);
  return (data?.[0] as CrossPostQueueRow | undefined) ?? null;
}

/**
 * Count a user's items in the given statuses since `sinceIso`.
 *
 * Throws on a query error rather than reporting zero. This backs the
 * per-user pending cap, and a rate limit that silently reports "no pending
 * items" whenever the database hiccups is a rate limit that fails OPEN —
 * exactly backwards. Callers turn the throw into a 503.
 */
export async function countQueueItemsForUser(args: {
  supabase: any;
  userId: string;
  statuses: CrossPostQueueStatus[];
  /** Scope to one platform. Leaving it out counts across all of them, which is
   *  almost never what a per-platform cap wants — see the callers. */
  target?: CrossPostTarget;
  sinceIso?: string;
}): Promise<number> {
  let query = args.supabase
    .from(CROSSPOST_QUEUE_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.userId)
    .in("status", args.statuses);
  if (args.target) query = query.eq("target", args.target);
  if (args.sinceIso) query = query.gte("created_at", args.sinceIso);
  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count queued cross-posts: ${error.message}`);
  }
  return count ?? 0;
}
