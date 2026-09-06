import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

function req(url = "http://localhost/api/userbase/notifications") {
  return new NextRequest(url, { method: "GET" });
}

async function loadRoute(opts: {
  supabase?: Record<string, FakeResult[]>;
  userId?: string | null;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.doMock("@/lib/userbase/session", () => ({
    resolveUserbaseUserId: vi.fn(async () => (opts.userId === undefined ? "user-1" : opts.userId)),
  }));
  vi.resetModules();
  const { GET } = await import("./route");
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { GET, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

describe("GET /api/userbase/notifications", () => {
  it("401s without a resolvable session", async () => {
    const { GET } = await loadRoute({ userId: null });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns the resolved user's notifications, newest first, scoped by user_id", async () => {
    const rows = [
      { id: "n2", user_id: "user-1", type: "crosspost_queued", title: "b", body: null, link: null, metadata: {}, read_at: null, created_at: "2026-01-02T00:00:00.000Z" },
      { id: "n1", user_id: "user-1", type: "crosspost_queued", title: "a", body: null, link: null, metadata: {}, read_at: null, created_at: "2026-01-01T00:00:00.000Z" },
    ];
    const { GET, calls } = await loadRoute({
      userId: "user-1",
      supabase: { userbase_notifications: [{ data: rows, error: null }] },
    });

    const res = await GET(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.notifications).toEqual(rows);
    const eqCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "eq");
    expect(eqCall?.args).toEqual(["user_id", "user-1"]);
    const orderCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "order");
    expect(orderCall?.args[0]).toBe("created_at");
    expect(orderCall?.args[1]).toMatchObject({ ascending: false });
  });

  it("scopes to whichever user the session resolves to", async () => {
    const { GET, calls } = await loadRoute({
      userId: "user-2",
      supabase: { userbase_notifications: [{ data: [], error: null }] },
    });

    await GET(req());

    const eqCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "eq");
    expect(eqCall?.args).toEqual(["user_id", "user-2"]);
  });

  it("applies a before cursor when given", async () => {
    const { GET, calls } = await loadRoute({
      userId: "user-1",
      supabase: { userbase_notifications: [{ data: [], error: null }] },
    });

    await GET(req("http://localhost/api/userbase/notifications?before=2026-01-01T00:00:00.000Z&limit=5"));

    const ltCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "lt");
    expect(ltCall?.args).toEqual(["created_at", "2026-01-01T00:00:00.000Z"]);
    const limitCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "limit");
    expect(limitCall?.args[0]).toBe(5);
  });

  it("500s when the backend isn't configured", async () => {
    vi.doMock("@/app/utils/supabase/supabaseClient", () => ({ supabaseAdmin: null }));
    vi.doMock("@/lib/userbase/session", () => ({ resolveUserbaseUserId: vi.fn(async () => "user-1") }));
    vi.resetModules();
    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
