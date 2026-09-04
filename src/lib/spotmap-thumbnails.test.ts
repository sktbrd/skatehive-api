import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

process.env.THUMBNAIL_SHARED_SECRET = "test-thumbnail-secret";
process.env.IMAGE_THUMBNAIL_SERVICE_URL = "https://transcoder.test/image-thumbnail";

async function loadModule(opts: {
  supabase?: Record<string, FakeResult[]>;
  fetchImpl?: (url: string, init?: any) => Promise<any>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.resetModules();
  const mod = await import("./spotmap-thumbnails");
  const fetchSpy = vi.fn(opts.fetchImpl || (async () => { throw new Error("fetch should not be called"); }));
  vi.stubGlobal("fetch", fetchSpy);
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { ...mod, fetchSpy, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

describe("buildHiveCdnThumb", () => {
  it("builds a resized images.hive.blog URL for an images.hive.blog source", async () => {
    const { buildHiveCdnThumb } = await import("./spotmap-thumbnails");
    const url = "https://images.hive.blog/DQmAbc/photo.jpg";
    expect(buildHiveCdnThumb(url, 400)).toBe(`https://images.hive.blog/400x400/${url}`);
  });

  it("builds a resized URL for a files.peakd.com source too", async () => {
    const { buildHiveCdnThumb } = await import("./spotmap-thumbnails");
    const url = "https://files.peakd.com/file/abc.jpg";
    expect(buildHiveCdnThumb(url, 400)).toBe(`https://images.hive.blog/400x400/${url}`);
  });

  it("returns null for a non-Hive origin", async () => {
    const { buildHiveCdnThumb } = await import("./spotmap-thumbnails");
    expect(buildHiveCdnThumb("https://mymaps.usercontent.google.com/photo.jpg", 400)).toBeNull();
  });

  it("returns null for a garbage URL instead of throwing", async () => {
    const { buildHiveCdnThumb } = await import("./spotmap-thumbnails");
    expect(buildHiveCdnThumb("not a url", 400)).toBeNull();
  });
});

describe("resolveSmallThumbnail", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns and persists the CDN URL synchronously for a Hive-hosted thumbnail", async () => {
    const { resolveSmallThumbnail, calls } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    const url = await resolveSmallThumbnail({
      id: "spot-1",
      thumbnail: "https://images.hive.blog/DQmAbc/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: null,
    });

    expect(url).toBe("https://images.hive.blog/400x400/https://images.hive.blog/DQmAbc/photo.jpg");
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toMatchObject({ thumbnail_small: url });
  });

  it("prefers thumbnail_override over thumbnail when computing the CDN URL", async () => {
    const { resolveSmallThumbnail } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    const url = await resolveSmallThumbnail({
      id: "spot-1",
      thumbnail: "https://images.hive.blog/old/photo.jpg",
      thumbnail_override: "https://images.hive.blog/new/photo.jpg",
      thumbnail_small: null,
    });

    expect(url).toContain("images.hive.blog/new/photo.jpg");
  });

  it("does not write to the DB again when the CDN URL already matches thumbnail_small", async () => {
    const cdnUrl = "https://images.hive.blog/400x400/https://images.hive.blog/DQmAbc/photo.jpg";
    const { resolveSmallThumbnail, calls } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    await resolveSmallThumbnail({
      id: "spot-1",
      thumbnail: "https://images.hive.blog/DQmAbc/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: cdnUrl,
    });

    expect(calls.filter((c) => c.method === "update")).toHaveLength(0);
  });

  it("queues a transcoder job and returns null for a non-Hive origin with no cached thumbnail_small", async () => {
    const { resolveSmallThumbnail, fetchSpy, calls } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async (url: string, init: any) => {
        expect(url).toBe("https://transcoder.test/image-thumbnail");
        expect(init.headers["x-thumbnail-secret"]).toBe("test-thumbnail-secret");
        expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/photo.jpg", maxPx: 400 });
        return { ok: true, json: async () => ({ url: "https://gateway.pinata.cloud/ipfs/abc.jpg" }) };
      },
    });

    const result = await resolveSmallThumbnail({
      id: "spot-2",
      thumbnail: "https://example.com/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: null,
    });

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // the persist happens once the background job resolves — give it a tick
    await new Promise((r) => setTimeout(r, 0));
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toMatchObject({ thumbnail_small: "https://gateway.pinata.cloud/ipfs/abc.jpg" });
  });

  it("dedupes concurrent calls for the same spot id, firing only one transcoder request", async () => {
    let calls = 0;
    const { resolveSmallThumbnail, fetchSpy } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, json: async () => ({ url: "https://gateway.pinata.cloud/ipfs/abc.jpg" }) };
      },
    });

    const spot = { id: "spot-3", thumbnail: "https://example.com/photo.jpg", thumbnail_override: null, thumbnail_small: null };
    await Promise.all([resolveSmallThumbnail(spot), resolveSmallThumbnail(spot)]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once attempts reach the cap, backoff permitting", async () => {
    vi.useFakeTimers();
    const { resolveSmallThumbnail, fetchSpy } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async () => ({ ok: false }),
    });

    const base = { thumbnail: "https://example.com/photo.jpg", thumbnail_override: null, thumbnail_small: null };
    for (let i = 0; i < 3; i++) {
      await resolveSmallThumbnail({ id: "spot-4", ...base });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10 * 60_000); // clear any backoff window
    }
    // 4th call: attempts already at the cap — must not fire again regardless of elapsed time
    await resolveSmallThumbnail({ id: "spot-4", ...base });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("never throws even when the transcoder call errors outright", async () => {
    const { resolveSmallThumbnail } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async () => { throw new Error("network down"); },
    });

    await expect(
      resolveSmallThumbnail({ id: "spot-5", thumbnail: "https://example.com/x.jpg", thumbnail_override: null, thumbnail_small: null })
    ).resolves.toBeNull();
  });

  it("returns null without any lookup when the spot has no thumbnail at all", async () => {
    const { resolveSmallThumbnail, fetchSpy, calls } = await loadModule({});

    const result = await resolveSmallThumbnail({ id: "spot-6", thumbnail: null, thumbnail_override: null, thumbnail_small: null });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("backfillSpotThumbnail", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves and persists synchronously for a Hive-hosted thumbnail", async () => {
    const { backfillSpotThumbnail, fetchSpy, calls } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    const result = await backfillSpotThumbnail({
      id: "spot-1",
      thumbnail: "https://images.hive.blog/DQmAbc/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: null,
    });

    expect(result.status).toBe("ready");
    expect(result.thumbnailUrl).toContain("images.hive.blog/400x400/");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "update")).toBe(true);
  });

  it("awaits the transcoder call synchronously and persists the result for a non-Hive origin", async () => {
    const { backfillSpotThumbnail, fetchSpy } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async () => ({ ok: true, json: async () => ({ url: "https://gateway.pinata.cloud/ipfs/abc.jpg" }) }),
    });

    const result = await backfillSpotThumbnail({
      id: "spot-2",
      thumbnail: "https://example.com/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: null,
    });

    expect(result).toEqual({ status: "ready", thumbnailUrl: "https://gateway.pinata.cloud/ipfs/abc.jpg" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports failed when the transcoder call comes back empty", async () => {
    const { backfillSpotThumbnail } = await loadModule({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
      fetchImpl: async () => ({ ok: false }),
    });

    const result = await backfillSpotThumbnail({
      id: "spot-3",
      thumbnail: "https://example.com/photo.jpg",
      thumbnail_override: null,
      thumbnail_small: null,
    });

    expect(result).toEqual({ status: "failed" });
  });

  it("skips a spot with no thumbnail source", async () => {
    const { backfillSpotThumbnail, fetchSpy } = await loadModule({});

    const result = await backfillSpotThumbnail({ id: "spot-4", thumbnail: null, thumbnail_override: null, thumbnail_small: null });

    expect(result).toEqual({ status: "skipped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
