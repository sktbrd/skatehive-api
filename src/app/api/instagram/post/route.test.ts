import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const HIVE_AUTHOR = "tonyhawk";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/instagram/post", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function baseBody(overrides: Record<string, any> = {}) {
  return {
    hive_author: HIVE_AUTHOR,
    hive_permlink: "a-trick",
    title: "A trick",
    body: "Landed it finally",
    permalink_url: "https://skatehive.app/post/@tonyhawk/a-trick",
    image_url: "https://images.hive.blog/DQm/photo.jpg",
    ...overrides,
  };
}

async function loadRoute(opts: {
  supabase?: Record<string, FakeResult[]>;
  userId?: string | null;
  hiveHandle?: string | null;
  hivePower?: number | null;
  igHandle?: string | null;
  fetchImpl?: (...args: any[]) => Promise<any>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.doMock("@/lib/userbase/session", () => ({
    resolveUserbaseUserId: vi.fn(async () => (opts.userId === undefined ? USER_ID : opts.userId)),
    getPrimaryHiveHandle: vi.fn(async () => (opts.hiveHandle === undefined ? HIVE_AUTHOR : opts.hiveHandle)),
  }));
  vi.doMock("@/lib/instagram/serverHivePower", () => ({
    getHivePowerForAccount: vi.fn(async () => (opts.hivePower === undefined ? 150 : opts.hivePower)),
  }));
  vi.doMock("@/lib/instagram/resolveIgHandle", () => ({
    resolveIgHandleForCaption: vi.fn(async () => (opts.igHandle === undefined ? "tonyhawkig" : opts.igHandle)),
  }));
  const fetchSpy = vi.fn(opts.fetchImpl || (async () => { throw new Error("fetch should not be called"); }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.resetModules();
  const { POST } = await import("./route");
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { POST, fetchSpy, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

function callsFor(calls: FakeCall[], table: string, method: string) {
  return calls.filter((c) => c.table === table && c.method === method);
}

describe("POST /api/instagram/post (enqueue only)", () => {
  it("enqueues pending_review, writes the crosspost_queued notification, and never touches the Instagram Graph API", async () => {
    const { POST, fetchSpy, calls } = await loadRoute({
      supabase: {
        userbase_instagram_posts: [
          { data: [], error: null }, // dedupe: not already published
          { data: null, error: null, count: 0 }, // 24h published count
        ],
        userbase_crosspost_queue: [
          { data: null, error: null, count: 0 }, // 5-pending cap
          { data: [], error: null }, // findActiveQueueItem pre-check
          { data: { id: "queue-1" }, error: null }, // insert
        ],
        userbase_notifications: [{ data: null, error: null }],
      },
    });

    const res = await POST(req(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toEqual({ status: "pending_review", queue_id: "queue-1" });
    expect(fetchSpy).not.toHaveBeenCalled();

    const insert = callsFor(calls, "userbase_crosspost_queue", "insert")[0];
    expect(insert.args[0]).toMatchObject({
      user_id: USER_ID,
      requested_by_handle: HIVE_AUTHOR,
      target: "instagram",
      hive_author: HIVE_AUTHOR,
      hive_permlink: "a-trick",
      status: "pending_review",
    });
    expect(insert.args[0].payload).toMatchObject({
      image_url: "https://images.hive.blog/DQm/photo.jpg",
      video_url: null,
      ig_media_type: "IMAGE",
      permalink_url: "https://skatehive.app/post/@tonyhawk/a-trick",
      collaborators: ["tonyhawkig"],
    });
    expect(typeof insert.args[0].payload.caption).toBe("string");

    const notify = callsFor(calls, "userbase_notifications", "insert")[0];
    expect(notify.args[0]).toMatchObject({
      user_id: USER_ID,
      type: "crosspost_queued",
      link: "https://skatehive.app/post/@tonyhawk/a-trick",
    });
    expect(notify.args[0].metadata).toMatchObject({ queue_id: "queue-1", target: "instagram" });
  });

  it("enqueues even when CROSSPOST_QUEUE_ENABLED would disable the web's queue for this handle", async () => {
    const original = process.env.CROSSPOST_QUEUE_ENABLED;
    process.env.CROSSPOST_QUEUE_ENABLED = "false";
    try {
      const { POST } = await loadRoute({
        supabase: {
          userbase_instagram_posts: [{ data: [], error: null }, { data: null, error: null, count: 0 }],
          userbase_crosspost_queue: [
            { data: null, error: null, count: 0 },
            { data: [], error: null },
            { data: { id: "queue-2" }, error: null },
          ],
          userbase_notifications: [{ data: null, error: null }],
        },
      });
      const res = await POST(req(baseBody()));
      const json = await res.json();
      expect(res.status).toBe(202);
      expect(json.status).toBe("pending_review");
    } finally {
      process.env.CROSSPOST_QUEUE_ENABLED = original;
    }
  });

  it("429s once the user already has 5 pending cross-posts, without inserting into the queue", async () => {
    const { POST, calls } = await loadRoute({
      supabase: {
        userbase_instagram_posts: [{ data: [], error: null }, { data: null, error: null, count: 0 }],
        userbase_crosspost_queue: [{ data: null, error: null, count: 5 }],
      },
    });

    const res = await POST(req(baseBody()));
    expect(res.status).toBe(429);
    expect(callsFor(calls, "userbase_crosspost_queue", "insert")).toHaveLength(0);
  });

  it("401s when there is no session and no valid signature", async () => {
    const { POST } = await loadRoute({ userId: null });
    const res = await POST(req(baseBody()));
    expect(res.status).toBe(401);
  });

  it("403s when the session's linked handle doesn't match the requested author", async () => {
    const { POST } = await loadRoute({ hiveHandle: "someoneelse" });
    const res = await POST(req(baseBody()));
    expect(res.status).toBe(403);
  });

  it("403s when Hive Power is below the 100 HP threshold", async () => {
    const { POST } = await loadRoute({ hivePower: 50 });
    const res = await POST(req(baseBody()));
    expect(res.status).toBe(403);
  });

  it("400s for a media URL host that isn't on the allow-list", async () => {
    const { POST } = await loadRoute({});
    const res = await POST(req(baseBody({ image_url: "https://evil.example.com/x.jpg" })));
    expect(res.status).toBe(400);
  });

  it("200s with the cached IG link when the snap is already published (dedupe)", async () => {
    const { POST, calls } = await loadRoute({
      supabase: {
        userbase_instagram_posts: [
          {
            data: [{ id: "old-1", status: "published", ig_media_id: "media-1", ig_permalink: "https://instagram.com/p/xyz", created_at: new Date().toISOString() }],
            error: null,
          },
        ],
      },
    });

    const res = await POST(req(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, deduped: true, ig_media_id: "media-1", ig_permalink: "https://instagram.com/p/xyz" });
    expect(callsFor(calls, "userbase_crosspost_queue", "insert")).toHaveLength(0);
  });

  it("429s at the 24h published cap before ever checking the pending queue cap", async () => {
    const { POST, calls } = await loadRoute({
      supabase: {
        userbase_instagram_posts: [{ data: [], error: null }, { data: null, error: null, count: 7 }],
      },
    });

    const res = await POST(req(baseBody()));
    expect(res.status).toBe(429);
    expect(callsFor(calls, "userbase_crosspost_queue", "select")).toHaveLength(0);
  });
});
