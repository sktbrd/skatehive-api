import { describe, expect, it, vi } from "vitest";
import { makeFakeSupabase, type FakeResult } from "@/test/fakeSupabase";

function spotRow(overrides: Record<string, any> = {}) {
  return {
    id: "spot-1",
    source: "hive",
    source_id: "author/permlink",
    name: "Test Spot",
    lat: 1,
    lng: 2,
    address: null,
    thumbnail: "https://images.hive.blog/DQmAbc/photo.jpg",
    thumbnail_override: null,
    thumbnail_small: null,
    hive_author: "author",
    hive_permlink: "permlink",
    hive_created: "2026-01-01T00:00:00.000Z",
    kml_description: null,
    ...overrides,
  };
}

async function loadRoute(opts: {
  supabase?: Record<string, FakeResult[]>;
  resolveSmallThumbnail?: (spot: any) => Promise<string | null>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  const resolveSmallThumbnail = vi.fn(opts.resolveSmallThumbnail || (async () => null));
  vi.doMock("@/lib/spotmap-thumbnails", () => ({ resolveSmallThumbnail }));
  // Real Next `after()` requires an actual request-scoped context (it uses
  // AsyncLocalStorage under the hood) that calling GET() directly in a test
  // doesn't establish — it throws outside that context. Stub it to run the
  // callback immediately so the fire-and-forget queuing is inspectable.
  const after = vi.fn((cb: () => void) => cb());
  vi.doMock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>();
    return { ...actual, after };
  });
  vi.resetModules();
  const { GET } = await import("./route");
  return { GET, resolveSmallThumbnail, after };
}

describe("GET /api/spotmap", () => {
  it("coalesces thumbnail_override over thumbnail in the response", async () => {
    const { GET } = await loadRoute({
      supabase: {
        spotmap_spots: [
          { data: [spotRow({ thumbnail: "https://a.example/x.jpg", thumbnail_override: "https://b.example/y.jpg" })], error: null },
        ],
      },
    });

    const res = await GET();
    const json = await res.json();

    expect(json.spots[0].thumbnail).toBe("https://b.example/y.jpg");
  });

  it("falls back thumbnail_small to the coalesced thumbnail when the DB value is null", async () => {
    const { GET } = await loadRoute({
      supabase: {
        spotmap_spots: [
          { data: [spotRow({ thumbnail: "https://a.example/x.jpg", thumbnail_override: null, thumbnail_small: null })], error: null },
        ],
      },
    });

    const res = await GET();
    const json = await res.json();

    expect(json.spots[0].thumbnail_small).toBe("https://a.example/x.jpg");
  });

  it("returns the stored thumbnail_small as-is when present, without falling back", async () => {
    const { GET } = await loadRoute({
      supabase: {
        spotmap_spots: [
          { data: [spotRow({ thumbnail_small: "https://images.hive.blog/400x400/https://a.example/x.jpg" })], error: null },
        ],
      },
    });

    const res = await GET();
    const json = await res.json();

    expect(json.spots[0].thumbnail_small).toBe("https://images.hive.blog/400x400/https://a.example/x.jpg");
  });

  it("lazily queues generation (via after()) only for rows missing thumbnail_small, without blocking the response", async () => {
    const rows = [
      spotRow({ id: "spot-missing", thumbnail_small: null }),
      spotRow({ id: "spot-ready", thumbnail_small: "https://images.hive.blog/400x400/already.jpg" }),
    ];
    const { GET, resolveSmallThumbnail, after } = await loadRoute({
      supabase: { spotmap_spots: [{ data: rows, error: null }] },
    });

    const res = await GET();
    await res.json();

    expect(after).toHaveBeenCalledTimes(1);
    expect(resolveSmallThumbnail).toHaveBeenCalledTimes(1);
    expect(resolveSmallThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "spot-missing" })
    );
  });

  it("never queues a row whose coalesced thumbnail isn't http(s)", async () => {
    const rows = [
      spotRow({ id: "spot-bad", thumbnail: "javascript:alert(1)", thumbnail_override: null, thumbnail_small: null }),
      spotRow({ id: "spot-empty", thumbnail: null, thumbnail_override: null, thumbnail_small: null }),
    ];
    const { GET, resolveSmallThumbnail } = await loadRoute({
      supabase: { spotmap_spots: [{ data: rows, error: null }] },
    });

    const res = await GET();
    await res.json();

    expect(resolveSmallThumbnail).not.toHaveBeenCalled();
  });

  it("bounds lazy generation to at most 5 rows per request", async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      spotRow({ id: `spot-${i}`, thumbnail: `https://images.hive.blog/x${i}.jpg`, thumbnail_small: null })
    );
    const { GET, resolveSmallThumbnail } = await loadRoute({
      supabase: { spotmap_spots: [{ data: rows, error: null }] },
    });

    const res = await GET();
    await res.json();

    expect(resolveSmallThumbnail).toHaveBeenCalledTimes(5);
  });

  it("500s when the backend isn't configured", async () => {
    vi.doMock("@/app/utils/supabase/supabaseClient", () => ({ supabaseAdmin: null }));
    vi.doMock("@/lib/spotmap-thumbnails", () => ({ resolveSmallThumbnail: vi.fn() }));
    vi.resetModules();
    const { GET } = await import("./route");

    const res = await GET();
    expect(res.status).toBe(500);
  });
});
