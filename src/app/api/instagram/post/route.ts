import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";
import {
  isInstagramConfigured,
  publishImageToInstagram,
  publishReelToInstagram,
} from "@/lib/instagram/graph";
import { buildInstagramCaption } from "@/lib/instagram/caption";
import { resolveIgHandleForCaption } from "@/lib/instagram/resolveIgHandle";
import { getHivePowerForAccount } from "@/lib/instagram/serverHivePower";
import {
  buildIgAuthMessage,
  verifyHiveSignature,
  getOrCreateHiveUserId,
} from "@/lib/instagram/signatureAuth";
import { resolveUserbaseUserId, getPrimaryHiveHandle } from "@/lib/userbase/session";
import { isAllowedInstagramMediaUrl, mediaIsFetchable } from "@/lib/instagram/mediaValidation";

export const runtime = "nodejs";
export const maxDuration = 300; // Reels can poll up to ~3 min before publish

const PER_USER_24H_LIMIT = 7;
const MIN_HIVE_POWER_TO_CROSSPOST = 100;

function isCollaboratorVisibilityError(error: string | undefined) {
  return /user not visible|collaborator|invite/i.test(error || "");
}

// Cross-post a Hive snap to the shared @skatehive Instagram account.
// Auth: per-request posting-key signature (no session). The signature proves
// the caller owns `hive_author`; we then HP-gate, dedupe, and publish.
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Userbase backend not configured" }, { status: 500 });
  }
  if (!isInstagramConfigured()) {
    return NextResponse.json(
      { error: "Instagram cross-posting is not configured on the server." },
      { status: 503 }
    );
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

  // 4. Validate payload.
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

  // 5. Dedupe / retry (UNIQUE(hive_author, hive_permlink)).
  const { data: existingRows } = await supabaseAdmin
    .from("userbase_instagram_posts")
    .select("id, status, ig_media_id, ig_permalink, created_at")
    .eq("hive_author", hiveAuthor)
    .eq("hive_permlink", hivePermlink)
    .limit(1);
  const existing = existingRows?.[0];
  if (existing && existing.status === "published") {
    return NextResponse.json(
      { success: true, deduped: true, ig_media_id: existing.ig_media_id, ig_permalink: existing.ig_permalink },
      { status: 200 }
    );
  }
  let existingRetryableId: string | null = null;
  if (existing) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (existing.status === "failed" || (existing.status === "queued" && ageMs > 10 * 60 * 1000)) {
      existingRetryableId = existing.id as string;
    } else {
      return NextResponse.json(
        { error: "This snap is already being cross-posted. Try again in a minute." },
        { status: 409 }
      );
    }
  }

  // 6. Per-user 24h cap.
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

  // 7. Caption + collaborators. Honor a user-edited override / explicit
  // collaborators (web review dialog); otherwise build server-side + default
  // the collaborator to the author's resolved IG handle.
  const igHandle = await resolveIgHandleForCaption({ hiveAuthor, userId, supabase: supabaseAdmin });
  const captionOverride = typeof body?.caption === "string" ? body.caption.trim() : "";
  const caption = captionOverride
    ? captionOverride.slice(0, 2200)
    : buildInstagramCaption({ title, body: markdown, hiveAuthor, permalinkUrl, extraTags: tags, igHandle });
  const collaborators: string[] | undefined = Array.isArray(body?.collaborators)
    ? body.collaborators.filter((c: unknown): c is string => typeof c === "string")
    : igHandle
      ? [igHandle]
      : undefined;
  const mediaType: "IMAGE" | "REELS" = videoUrl ? "REELS" : "IMAGE";

  // 8. Record queued row (insert or retry-update).
  let queuedId: string;
  if (existingRetryableId) {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("userbase_instagram_posts")
      .update({
        user_id: userId,
        ig_media_type: mediaType,
        caption,
        image_url: imageUrl || null,
        video_url: videoUrl || null,
        status: "queued",
        error: null,
        ig_container_id: null,
        ig_media_id: null,
        ig_permalink: null,
        published_at: null,
      })
      .eq("id", existingRetryableId)
      .select("id")
      .single();
    if (updateErr || !updated) {
      return NextResponse.json({ error: updateErr?.message || "Failed to re-queue cross-post." }, { status: 500 });
    }
    queuedId = updated.id as string;
  } else {
    const { data: queued, error: insertErr } = await supabaseAdmin
      .from("userbase_instagram_posts")
      .insert({
        user_id: userId,
        hive_author: hiveAuthor,
        hive_permlink: hivePermlink,
        ig_media_type: mediaType,
        caption,
        image_url: imageUrl || null,
        video_url: videoUrl || null,
        status: "queued",
      })
      .select("id")
      .single();
    if (insertErr || !queued) {
      return NextResponse.json({ error: insertErr?.message || "Failed to record cross-post." }, { status: 500 });
    }
    queuedId = queued.id as string;
  }

  // 9. Pre-flight: make sure Meta can actually fetch the media (IPFS CIDs that
  // never pinned would otherwise come back as the opaque 2207077). Marked
  // retryable so the user can try again once the upload finishes pinning.
  if (!(await mediaIsFetchable(videoUrl || imageUrl))) {
    const error =
      "Media isn't reachable on the IPFS gateway yet — it may still be uploading/pinning. Try cross-posting again in a moment.";
    await supabaseAdmin.from("userbase_instagram_posts").update({ status: "failed", error }).eq("id", queuedId);
    return NextResponse.json({ error }, { status: 503 });
  }

  // 10. Publish (retry once without collaborators on a visibility error).
  let publishResult = videoUrl
    ? await publishReelToInstagram({ videoUrl, caption, coverUrl: imageUrl || undefined, collaborators })
    : await publishImageToInstagram({ imageUrl, caption, collaborators });
  let collaboratorRetryError: string | null = null;
  if (!publishResult.success && collaborators?.length && isCollaboratorVisibilityError(publishResult.error)) {
    collaboratorRetryError = publishResult.error;
    publishResult = videoUrl
      ? await publishReelToInstagram({ videoUrl, caption, coverUrl: imageUrl || undefined })
      : await publishImageToInstagram({ imageUrl, caption });
  }

  if (!publishResult.success) {
    const error = collaboratorRetryError
      ? `${publishResult.error} (also retried without collaborator after: ${collaboratorRetryError})`
      : publishResult.error;
    await supabaseAdmin.from("userbase_instagram_posts").update({ status: "failed", error }).eq("id", queuedId);
    return NextResponse.json({ error }, { status: 502 });
  }

  await supabaseAdmin
    .from("userbase_instagram_posts")
    .update({
      status: "published",
      ig_container_id: publishResult.containerId,
      ig_media_id: publishResult.mediaId,
      ig_permalink: publishResult.permalink || null,
      published_at: new Date().toISOString(),
    })
    .eq("id", queuedId);

  return NextResponse.json({
    success: true,
    ig_media_id: publishResult.mediaId,
    ig_permalink: publishResult.permalink || null,
  });
}
