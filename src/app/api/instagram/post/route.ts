import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import { buildInstagramCaption } from "@/lib/instagram/caption";
import { resolveIgHandleForCaption } from "@/lib/instagram/resolveIgHandle";
import { getHivePowerForAccount } from "@/lib/instagram/serverHivePower";
import {
  buildIgAuthMessage,
  verifyHiveSignature,
  getOrCreateHiveUserId,
} from "@/lib/instagram/signatureAuth";
import { resolveUserbaseUserId, getPrimaryHiveHandle } from "@/lib/userbase/session";
import { isAllowedInstagramMediaUrl } from "@/lib/instagram/mediaValidation";
import {
  countQueueItemsForUser,
  enqueueCrossPost,
  type InstagramQueuePayload,
} from "@/lib/crosspost/queue";
import { notifyCrossPostQueued } from "@/lib/notifications/appNotifications";

export const runtime = "nodejs";

const PER_USER_24H_LIMIT = 7;
const PER_USER_PENDING_LIMIT = 5;
const MIN_HIVE_POWER_TO_CROSSPOST = 100;

/**
 * POST /api/instagram/post
 *
 * File a request to cross-post an already-published Hive snap to the shared
 * @skatehive Instagram account. This route does NOT publish — it never calls
 * the Graph API — it validates + builds the exact payload a curator would
 * need, then files it as `pending_review` in userbase_crosspost_queue. The
 * curation team publishes from the portal.
 *
 * Unlike the web app, this route ignores CROSSPOST_QUEUE_ENABLED: mobile
 * never publishes inline, by design, so every request lands in the queue
 * regardless of that flag (which only affects skatehive3.0's own route).
 *
 * Auth: per-request posting-key signature (mobile, no session) OR a userbase
 * session (bearer/cookie). Either path resolves the authenticated Hive
 * author + a userbase user_id.
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Userbase backend not configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  let hiveAuthor = typeof body?.hive_author === "string" ? body.hive_author.trim().toLowerCase() : "";
  const hivePermlink = typeof body?.hive_permlink === "string" ? body.hive_permlink.trim() : "";
  const signature = typeof body?.hive_signature === "string" ? body.hive_signature : "";
  const publicKey = typeof body?.hive_public_key === "string" ? body.hive_public_key : "";
  const issuedAt = typeof body?.signed_at === "string" ? body.signed_at : "";

  if (!hivePermlink) {
    return NextResponse.json({ error: "Missing hive_permlink." }, { status: 400 });
  }

  // Auth: signature (mobile) OR userbase session (web cookie / bearer). Either
  // path resolves the authenticated Hive author + a userbase user_id.
  let userId: string | null;
  if (signature && publicKey && issuedAt) {
    if (!hiveAuthor) {
      return NextResponse.json({ error: "Missing hive_author." }, { status: 400 });
    }
    const verified = await verifyHiveSignature({
      message: buildIgAuthMessage({ hiveAuthor, hivePermlink, issuedAt }),
      hiveAuthor,
      hivePublicKey: publicKey,
      hiveSignature: signature,
      issuedAt,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status });
    }
    userId = await getOrCreateHiveUserId(hiveAuthor);
  } else {
    userId = await resolveUserbaseUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const linked = await getPrimaryHiveHandle(userId);
    if (!linked) {
      return NextResponse.json(
        { error: "Link a Hive account before cross-posting to Instagram." },
        { status: 403 }
      );
    }
    // Bind to the authenticated author; a client-supplied hive_author must match.
    if (hiveAuthor && hiveAuthor !== linked.toLowerCase()) {
      return NextResponse.json(
        { error: "You can only cross-post your own snaps to Instagram." },
        { status: 403 }
      );
    }
    hiveAuthor = linked.toLowerCase();
  }
  if (!userId) {
    return NextResponse.json({ error: "Could not resolve user." }, { status: 500 });
  }

  // Trusted-user gate (>=100 HP, on-chain, fail-closed).
  const hivePower = await getHivePowerForAccount(hiveAuthor);
  if (hivePower === null || hivePower < MIN_HIVE_POWER_TO_CROSSPOST) {
    return NextResponse.json(
      {
        error: `Cross-posting to Instagram requires at least ${MIN_HIVE_POWER_TO_CROSSPOST} HP.`,
        hive_power: hivePower,
      },
      { status: 403 }
    );
  }

  // Validate payload.
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const markdown = typeof body?.body === "string" ? body.body : "";
  const permalinkUrl = typeof body?.permalink_url === "string" ? body.permalink_url.trim() : "";
  const imageUrl = typeof body?.image_url === "string" ? body.image_url.trim() : "";
  const videoUrl = typeof body?.video_url === "string" ? body.video_url.trim() : "";
  const tags: string[] = Array.isArray(body?.tags)
    ? body.tags.filter((t: unknown): t is string => typeof t === "string")
    : [];

  if (!permalinkUrl) {
    return NextResponse.json({ error: "Missing permalink_url." }, { status: 400 });
  }
  if (!title && !markdown.trim()) {
    return NextResponse.json({ error: "Cross-post must have at least a title or body text." }, { status: 400 });
  }
  if (!imageUrl && !videoUrl) {
    return NextResponse.json({ error: "Instagram cross-posts require an image_url or video_url." }, { status: 400 });
  }
  for (const url of [imageUrl, videoUrl].filter(Boolean)) {
    if (!isAllowedInstagramMediaUrl(url)) {
      return NextResponse.json({ error: `Unsupported media URL: ${url}` }, { status: 400 });
    }
  }

  // Already live on Instagram → nothing to review, return the cached IDs.
  // (userbase_instagram_posts is written by the portal on a successful
  // publish, so this dedupe check still works even though this route never
  // writes that table itself any more.)
  const { data: existingRows } = await supabaseAdmin
    .from("userbase_instagram_posts")
    .select("id, status, ig_media_id, ig_permalink")
    .eq("hive_author", hiveAuthor)
    .eq("hive_permlink", hivePermlink)
    .eq("status", "published")
    .limit(1);
  const existing = existingRows?.[0];
  if (existing) {
    return NextResponse.json(
      {
        success: true,
        deduped: true,
        ig_media_id: existing.ig_media_id,
        ig_permalink: existing.ig_permalink,
      },
      { status: 200 }
    );
  }

  // Per-user 24h cap on PUBLISHED cross-posts.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: userCount } = await supabaseAdmin
    .from("userbase_instagram_posts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "published")
    .gte("created_at", since);
  if ((userCount ?? 0) >= PER_USER_24H_LIMIT) {
    return NextResponse.json(
      { error: `You've cross-posted to Instagram ${PER_USER_24H_LIMIT} times in the last 24 hours. Try again later.` },
      { status: 429 }
    );
  }

  // Queue-flood guard: cap how many of this user's requests can sit
  // unreviewed. A failure here must not wave the request through.
  let pendingCount: number;
  try {
    pendingCount = await countQueueItemsForUser({
      supabase: supabaseAdmin,
      userId,
      statuses: ["pending_review"],
      target: "instagram",
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn't check your pending cross-posts. Try again in a moment." },
      { status: 503 }
    );
  }
  if (pendingCount >= PER_USER_PENDING_LIMIT) {
    return NextResponse.json(
      {
        error: `You already have ${pendingCount} cross-posts waiting for the curation team. Wait for those to be reviewed before sending more.`,
      },
      { status: 429 }
    );
  }

  // Caption + collaborators. Honor a user-edited override / explicit
  // collaborators; otherwise build server-side + default the collaborator to
  // the author's resolved IG handle.
  const igHandle = await resolveIgHandleForCaption({ hiveAuthor, userId, supabase: supabaseAdmin });
  const captionOverride = typeof body?.caption === "string" ? body.caption.trim() : "";
  const caption = captionOverride
    ? captionOverride.slice(0, 2200)
    : buildInstagramCaption({ title, body: markdown, hiveAuthor, permalinkUrl, extraTags: tags, igHandle });
  const collaborators: string[] = Array.isArray(body?.collaborators)
    ? body.collaborators.filter((c: unknown): c is string => typeof c === "string")
    : igHandle
      ? [igHandle]
      : [];
  const mediaType: "IMAGE" | "REELS" = videoUrl ? "REELS" : "IMAGE";

  // File it for review. The payload is the finished publish input — the
  // portal posts exactly this, with no re-derivation, so what the curator
  // reviews is what Meta would receive.
  const payload: InstagramQueuePayload = {
    caption,
    collaborators,
    image_url: imageUrl || null,
    video_url: videoUrl || null,
    ig_media_type: mediaType,
    permalink_url: permalinkUrl,
    title,
    tags,
  };

  const enqueued = await enqueueCrossPost({
    supabase: supabaseAdmin,
    target: "instagram",
    userId,
    requestedByHandle: hiveAuthor,
    hiveAuthor,
    hivePermlink,
    payload,
  });

  if (!enqueued.ok) {
    return NextResponse.json({ error: enqueued.error }, { status: enqueued.status });
  }

  if (enqueued.duplicate) {
    // Already waiting for/through review — idempotent, not an error.
    return NextResponse.json({ status: enqueued.duplicate.status, queue_id: enqueued.id }, { status: 202 });
  }

  // Give the author something durable to come back to: the app's toast
  // covers the moment, this survives it.
  await notifyCrossPostQueued({
    supabase: supabaseAdmin,
    userId,
    queueId: enqueued.id,
    target: "instagram",
    hivePermlink,
    permalinkUrl,
  });

  return NextResponse.json({ status: "pending_review", queue_id: enqueued.id }, { status: 202 });
}
