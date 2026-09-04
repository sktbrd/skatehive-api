import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/spotmap/spot/spot-1", {
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
  vi.doMock("@/lib/spotmap-thumbnails", () => ({ resolveSmallThumbnail }));
  vi.resetModules();
  const { PATCH } = await import("./route");
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { PATCH, resolveSmallThumbnail, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

describe("PATCH /api/admin/spotmap/spot/[id]", () => {
  it("401s when there is no session", async () => {
    const { PATCH } = await loadRoute({ admin: { ok: false, hiveUsername: null, reason: "No session" } });

    const res = await PATCH(req({ name: "New name" }), params("spot-1"));
    expect(res.status).toBe(401);
  });

  it("403s when the caller isn't in the admin allow-list", async () => {
    const { PATCH } = await loadRoute({
      admin: { ok: false, hiveUsername: "rando", reason: "Not in admin allow-list" },
    });

    const res = await PATCH(req({ name: "New name" }), params("spot-1"));
    expect(res.status).toBe(403);
  });

  it("400s when no updatable fields are provided", async () => {
    const { PATCH } = await loadRoute({});

    const res = await PATCH(req({}), params("spot-1"));
    expect(res.status).toBe(400);
  });

  it("404s when the spot doesn't exist", async () => {
    const { PATCH } = await loadRoute({
      supabase: { spotmap_spots: [{ data: null, error: null }] },
    });

    const res = await PATCH(req({ name: "New name" }), params("missing-spot"));
    expect(res.status).toBe(404);
  });

  it("updates name/description without touching thumbnail_small when thumbnail_override isn't in the request", async () => {
    const { PATCH, resolveSmallThumbnail, calls } = await loadRoute({
      supabase: {
        spotmap_spots: [
          { data: { id: "spot-1", name: "New name", description: "New desc", thumbnail: "https://a.example/x.jpg", thumbnail_override: null, thumbnail_small: null }, error: null },
        ],
      },
    });

    const res = await PATCH(req({ name: "New name", description: "New desc" }), params("spot-1"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.spot.name).toBe("New name");
    expect(resolveSmallThumbnail).not.toHaveBeenCalled();
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toEqual({ name: "New name", description: "New desc" });
  });

  it("regenerates thumbnail_small when thumbnail_override changes", async () => {
    const { PATCH, resolveSmallThumbnail, calls } = await loadRoute({
      supabase: {
        spotmap_spots: [
          {
            data: {
              id: "spot-1",
              name: "Spot",
              thumbnail: "https://a.example/old.jpg",
              thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg",
              thumbnail_small: null,
            },
            error: null,
          },
        ],
      },
      resolveSmallThumbnail: async () => "https://images.hive.blog/400x400/https://images.hive.blog/DQmNew/photo.jpg",
    });

    const res = await PATCH(
      req({ thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg" }),
      params("spot-1")
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(resolveSmallThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "spot-1", thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg" })
    );
    expect(json.spot.thumbnail_small).toBe(
      "https://images.hive.blog/400x400/https://images.hive.blog/DQmNew/photo.jpg"
    );
    const update = calls.find((c) => c.table === "spotmap_spots" && c.method === "update");
    expect(update?.args[0]).toEqual({ thumbnail_override: "https://images.hive.blog/DQmNew/photo.jpg" });
  });

  it("500s when the update fails", async () => {
    const { PATCH } = await loadRoute({
      supabase: { spotmap_spots: [{ data: null, error: { message: "db exploded" } }] },
    });

    const res = await PATCH(req({ name: "New name" }), params("spot-1"));
    expect(res.status).toBe(500);
  });
});
