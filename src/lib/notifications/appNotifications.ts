/**
 * App-owned notifications (userbase_notifications — see the web repo's
 * migration 0030). Ported from skatehive3.0/lib/notifications/appNotifications.ts.
 *
 * Hive's bridge.account_notifications covers blockchain events. This covers
 * everything SkateHive itself decides — starting with the cross-post curation
 * queue telling an author their submission was filed for review.
 *
 * Writing a notification must never break the action that triggered it: this
 * app's enqueue should not 500 because the notify insert failed. The helper
 * swallows its errors and logs instead.
 */

/**
 * Who writes what:
 *   crosspost_queued    — this app (skatehive-api) AND the web app, the
 *                          moment a request is filed
 *   crosspost_rejected  — the portal (curator passed)
 *   crosspost_scheduled — the portal (approved for a future time)
 *   crosspost_published — the portal (it is live)
 *   crosspost_failed    — the portal (gave up publishing)
 *
 * An unknown type still renders on the client: the localizer falls back to
 * the row's stored title/body, so adding one on the portal side can't blank
 * out an inbox.
 */
export type AppNotificationType =
  | "crosspost_queued"
  | "crosspost_rejected"
  | "crosspost_scheduled"
  | "crosspost_published"
  | "crosspost_failed";

export interface CreateAppNotificationInput {
  supabase: any;
  userId: string;
  type: AppNotificationType;
  title: string;
  body?: string | null;
  /** In-app path or absolute URL the notification links to. */
  link?: string | null;
  metadata?: Record<string, unknown>;
}

export const APP_NOTIFICATIONS_TABLE = "userbase_notifications";

export async function createAppNotification(
  input: CreateAppNotificationInput
): Promise<boolean> {
  if (!input.supabase || !input.userId) return false;
  try {
    const { error } = await input.supabase.from(APP_NOTIFICATIONS_TABLE).insert({
      user_id: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn("[app-notifications] insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn("[app-notifications] insert threw:", err?.message);
    return false;
  }
}

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  farcaster: "Farcaster",
};

function platformLabel(target: string): string {
  return PLATFORM_LABEL[target] ?? target;
}

/**
 * The request was filed for review.
 *
 * Without this, sending a cross-post to curation produces nothing the author
 * can point at — possibly for days. Only this app writes it — at request
 * time the portal doesn't know the request exists yet.
 */
export async function notifyCrossPostQueued(args: {
  supabase: any;
  userId: string | null;
  queueId: string;
  target: string;
  hivePermlink: string | null;
  /** SkateHive URL of the snap, so the notification can link back to it. */
  permalinkUrl?: string | null;
}): Promise<void> {
  if (!args.userId) return;
  const platform = platformLabel(args.target);
  await createAppNotification({
    supabase: args.supabase,
    userId: args.userId,
    type: "crosspost_queued",
    title: `Your snap is with the curation team`,
    body: `They'll review it and post it${
      args.target === "instagram" ? " to @skatehive" : ""
    } on ${platform} if it fits the feed.`,
    link: args.permalinkUrl ?? null,
    metadata: {
      queue_id: args.queueId,
      target: args.target,
      hive_permlink: args.hivePermlink,
    },
  });
}
