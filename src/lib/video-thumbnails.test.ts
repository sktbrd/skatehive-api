import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall } from "@/test/fakeSupabase";
import { makeFakeSupabase } from "@/test/fakeSupabase";
import type { VideoEntry } from "./video-extraction";

process.env.PINATA_API_KEY = "test-pinata-key";
process.env.PINATA_SECRET_API_KEY = "test-pinata-secret";
process.env.THUMBNAIL_SERVICE_URL = "https://transcoder.test/thumbnail";
process.env.THUMBNAIL_SHARED_SECRET = "test-thumbnail-secret";

function video(overrides: Partial<VideoEntry> = {}): VideoEntry {
  return {
    videoUrl: "https://ipfs.skatehive.app/ipfs/bafybeigabc123",
    thumbnailUrl: null,
    author: "tonyhawk",
    permlink: "a-trick",
    title: "A trick",
    created: "2026-01-01T00:00:00.000Z",
    votes: 0,
    payout: "0",
    replies: 0,
    tags: [],
    active_votes: [],
    ...overrides,
  };
}

function pinataResponse(matches: boolean, thumbnailUrl?: string) {
  return {
    ok: true,
    json: async () => ({
      rows: matches
        ? [{ ipfs_pin_hash: "bafybeigabc123", metadata: { keyvalues: { thumbnailUrl } } }]
        : [],
    }),
  };
}

async function loadResolver(opts: {
  supabase?: Record<string, { data: any; error: any }[]>;
  fetchImpl: (url: string, init?: any) => Promise<any>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.resetModules();
  const mod = await import("./video-thumbnails");
  const fetchSpy = vi.fn(opts.fetchImpl);
  vi.stubGlobal("fetch", fetchSpy);
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { resolveThumbnails: mod.resolveThumbnails, fetchSpy, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

describe("resolveThumbnails", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves a video that already has a thumbnailUrl untouched, no lookups at all", async () => {
    const { resolveThumbnails, fetchSpy } = await loadResolver({
      fetchImpl: async () => { throw new Error("should not be called"); },
    });

    const [result] = await resolveThumbnails([video({ thumbnailUrl: "https://already.example/thumb.jpg" })]);

    expect(result.thumbnailUrl).toBe("https://already.example/thumb.jpg");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the DB thumbnail_url when the row is already ready, skipping Pinata and the transcoder", async () => {
    const { resolveThumbnails, fetchSpy } = await loadResolver({
      supabase: {
        video_thumbnails: [
          { data: [{ cid: "bafybeigabc123", thumbnail_url: "https://db.example/ready.jpg", status: "ready", attempts: 1, updated_at: new Date().toISOString() }], error: null },
        ],
      },
      fetchImpl: async () => { throw new Error("should not be called"); },
    });

    const [result] = await resolveThumbnails([video()]);

    expect(result.thumbnailUrl).toBe("https://db.example/ready.jpg");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to Pinata when there is no ready DB row, and does not queue the transcoder", async () => {
    const { resolveThumbnails, fetchSpy, calls } = await loadResolver({
      supabase: { video_thumbnails: [{ data: [], error: null }] },
      fetchImpl: async (url: string) => {
        expect(String(url)).toContain("pinata.cloud");
        return pinataResponse(true, "https://pinata.example/thumb.jpg");
      },
    });

    const [result] = await resolveThumbnails([video()]);

    expect(result.thumbnailUrl).toBe("https://pinata.example/thumb.jpg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.table === "video_thumbnails" && (c.method === "upsert" || c.method === "insert"))).toBe(false);
  });

  it("queues a transcoder job and returns null when metadata, DB, and Pinata all miss", async () => {
    const { resolveThumbnails, fetchSpy, calls } = await loadResolver({
      supabase: { video_thumbnails: [{ data: [], error: null }] },
      fetchImpl: async (url: string, init?: any) => {
        if (String(url).includes("pinata.cloud")) return pinataResponse(false);
        expect(String(url)).toBe("https://transcoder.test/thumbnail");
        expect(init.headers["x-thumbnail-secret"]).toBe("test-thumbnail-secret");
        expect(JSON.parse(init.body)).toEqual({ cid: "bafybeigabc123" });
        return { ok: true, json: async () => ({ cid: "bafybeigabc123", thumbnailUrl: "https://new.example/thumb.jpg" }) };
      },
    });

    const [result] = await resolveThumbnails([video()]);

    expect(result.thumbnailUrl).toBeNull();
    const pending = calls.find((c) => c.table === "video_thumbnails" && c.method === "upsert");
    expect(pending?.args[0]).toMatchObject({ cid: "bafybeigabc123", status: "pending", attempts: 1 });
  });

  it("does not re-queue a pending row still inside its backoff window", async () => {
    const { resolveThumbnails, fetchSpy } = await loadResolver({
      supabase: {
        video_thumbnails: [
          { data: [{ cid: "bafybeigabc123", thumbnail_url: null, status: "pending", attempts: 1, updated_at: new Date().toISOString() }], error: null },
        ],
      },
      fetchImpl: async (url: string) => {
        if (String(url).includes("pinata.cloud")) return pinataResponse(false);
        throw new Error("transcoder should not be called inside the backoff window");
      },
    });

    const [result] = await resolveThumbnails([video()]);

    expect(result.thumbnailUrl).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Pinata only
  });

  it("stops retrying once attempts reach the cap", async () => {
    const { resolveThumbnails, fetchSpy } = await loadResolver({
      supabase: {
        video_thumbnails: [
          { data: [{ cid: "bafybeigabc123", thumbnail_url: null, status: "failed", attempts: 3, updated_at: new Date(0).toISOString() }], error: null },
        ],
      },
      fetchImpl: async (url: string) => {
        if (String(url).includes("pinata.cloud")) return pinataResponse(false);
        throw new Error("transcoder should not be called once attempts hit the cap");
      },
    });

    const [result] = await resolveThumbnails([video()]);

    expect(result.thumbnailUrl).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Pinata only
  });
});
