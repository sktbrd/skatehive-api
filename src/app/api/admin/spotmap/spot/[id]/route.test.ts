import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

const SPOT_ID = "11111111-1111-1111-1111-111111111111";

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/admin/spotmap/spot/${SPOT_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function loadRoute(opts: {
  supabase?: Record<string, FakeResult[]>;
  admin?: { ok: boolean; hiveUsername: string | null; reason?: string };
  resolveSmallThumbnail?: (spot: any) => Promise<string | null>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.doMock("@/lib/spotmap-admin", () => ({
    requireSpotmapAdmin: vi.fn(async () => opts.admin ?? { ok: true, hiveUsername: "admin1" }),
  }));
  const resolveSmallThumbnail = vi.fn(opts.resolveSmallThumbnail || (async () => null));
  vi.doMock("@/lib/spotmap-thumbnails", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/spotmap-thumbnails")>();
    return { ...actual, resolveSmallThumbnail };
  });
  vi.resetModules();
  const { PATCH } = await import("./route");
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { PATCH, resolveSmallThumbnail, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

function spotRow(overrides: Record<string, any> = {}) {
  return {
    id: SPOT_ID,
    name: "Spot",
    description: null,
    thumbnail: "https://a.example/old.jpg",
    thumbnail_override: null,
    thumbnail_small: null,
    ...overrides,
  };
}

describe("PATCH /api/admin/spotmap/spot/[id]", () => {
  it("401s when there is no session", async () => {
    const { PATCH } = await loadRoute({ admin: { ok: false, hiveUsername: null, reason: "No session" } });

    const res = await PATCH(req({ name: "New name" }), params(SPOT_ID));
    expect(res.status).toBe(401);
  });

  it("403s when the caller isn't in the admin allow-list, with a generic message", async () => {
    const notAdmin = await loadRoute({
      admin: { ok: false, hiveUsername: "rando", reason: "Not in admin allow-list" },
    });
    const noIdentity = await loadRoute({
      admin: { ok: false, hiveUsername: null, reason: "No linked Hive identity" },
    });

    const res1 = await notAdmin.PATCH(req({ name: "New name" }), params(SPOT_ID));
    const res2 = await noIdentity.PATCH(req({ name: "New name" }), params(SPOT_ID));
    const json1 = await res1.json();
    const json2 = await res2.json();

    expect(res1.status).toBe(403);
    expect(res2.status).toBe(403);
    // Same message regardless of the underlying reason — don't leak which
    // check failed (no identity vs. not on the allow-list).
    expect(json1.error).toBe(json2.error);
  });

  it("400s for a malformed id (not a uuid)", async () => {
    const { PATCH } = await loadRoute({});

    const res = await PATCH(req({ name: "New name" }), params("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("400s when no updatable fields are provided", async () => {
    const { PATCH } = await loadRoute({});

    const res = await PATCH(req({}), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("404s when the spot doesn't exist", async () => {
    const { PATCH } = await loadRoute({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    const res = await PATCH(req({ name: "New name" }), params(SPOT_ID));
    expect(res.status).toBe(404);
  });

  it("updates name/description without touching thumbnail_small when thumbnail_override isn't in the request", async () => {
    const { PATCH, resolveSmallThumbnail, calls } = await loadRoute({
      supabase: {
        spotmap_spots: [{ data: spotRow({ name: "New name", description: "New desc" }), error: null }],
      },
    });

    const res = await PATCH(req({ name: "New name", description: "New desc" }), params(SPOT_ID));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.spot.name).toBe("New name");
    expect(resolveSmallThumbnail).not.toHaveBeenCalled();
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toEqual({ name: "New name", description: "New desc" });
  });

  it("400s when name exceeds 200 characters", async () => {
    const { PATCH } = await loadRoute({});
    const res = await PATCH(req({ name: "x".repeat(201) }), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("400s when description exceeds 5000 characters", async () => {
    const { PATCH } = await loadRoute({});
    const res = await PATCH(req({ description: "x".repeat(5001) }), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("400s when thumbnail_override isn't on the allow-list", async () => {
    const { PATCH } = await loadRoute({});
    const res = await PATCH(req({ thumbnail_override: "https://evil.example.com/x.jpg" }), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("400s when thumbnail_override is http instead of https", async () => {
    const { PATCH } = await loadRoute({});
    const res = await PATCH(req({ thumbnail_override: "http://images.hive.blog/x.jpg" }), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("400s when thumbnail_override exceeds 2048 characters", async () => {
    const { PATCH } = await loadRoute({});
    const longUrl = "https://images.hive.blog/" + "a".repeat(2048);
    const res = await PATCH(req({ thumbnail_override: longUrl }), params(SPOT_ID));
    expect(res.status).toBe(400);
  });

  it("clears the override and nulls thumbnail_small when thumbnail_override is set to null", async () => {
    const { PATCH, calls } = await loadRoute({
      supabase: {
        spotmap_spots: [{ data: spotRow({ thumbnail_override: null, thumbnail_small: null }), error: null }],
      },
    });

    const res = await PATCH(req({ thumbnail_override: null }), params(SPOT_ID));
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toEqual({ thumbnail_override: null, thumbnail_small: null });
  });

  it("regenerates thumbnail_small when thumbnail_override changes, nulling it in the write first", async () => {
    const { PATCH, resolveSmallThumbnail, calls } = await loadRoute({
      supabase: {
        spotmap_spots: [
          {
            data: spotRow({
              thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg",
              thumbnail_small: null,
            }),
            error: null,
          },
        ],
      },
      resolveSmallThumbnail: async () => "https://images.hive.blog/400x400/https://images.hive.blog/DQmNew/photo.jpg",
    });

    const res = await PATCH(
      req({ thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg" }),
      params(SPOT_ID)
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(resolveSmallThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ id: SPOT_ID, thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg" })
    );
    expect(json.spot.thumbnail_small).toBe(
      "https://images.hive.blog/400x400/https://images.hive.blog/DQmNew/photo.jpg"
    );
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toEqual({
      thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg",
      thumbnail_small: null,
    });
  });

  it("500s when the update fails", async () => {
    const { PATCH } = await loadRoute({
      supabase: { spotmap_spots: [{ data: null, error: { message: "db exploded" } }] },
    });

    const res = await PATCH(req({ name: "New name" }), params(SPOT_ID));
    expect(res.status).toBe(500);
  });
});
