import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/userbase/notifications/read", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
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
  const { POST } = await import("./route");
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { POST, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

describe("POST /api/userbase/notifications/read", () => {
  it("401s without a resolvable session", async () => {
    const { POST } = await loadRoute({ userId: null });
    const res = await POST(req({ all: true }));
    expect(res.status).toBe(401);
  });

  it("400s when neither ids nor all is provided", async () => {
    const { POST } = await loadRoute({});
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("marks the given ids read, scoped to the resolved user, setting a real read_at", async () => {
    const { POST, calls } = await loadRoute({
      userId: "user-1",
      supabase: { userbase_notifications: [{ data: null, error: null }] },
    });

    const res = await POST(req({ ids: ["n1", "n2"] }));
    expect(res.status).toBe(200);

    const update = calls.find((c) => c.table === "userbase_notifications" && c.method === "update");
    expect(update?.args[0].read_at).toEqual(expect.any(String));
    expect(new Date(update!.args[0].read_at).toString()).not.toBe("Invalid Date");

    const eqCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "eq");
    expect(eqCall?.args).toEqual(["user_id", "user-1"]);
    const inCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "in");
    expect(inCall?.args).toEqual(["id", ["n1", "n2"]]);
  });

  it("marks every unread notification read when all=true, without an id filter", async () => {
    const { POST, calls } = await loadRoute({
      userId: "user-1",
      supabase: { userbase_notifications: [{ data: null, error: null }] },
    });

    const res = await POST(req({ all: true }));
    expect(res.status).toBe(200);

    const inCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "in");
    expect(inCall).toBeUndefined();
    const eqCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "eq");
    expect(eqCall?.args).toEqual(["user_id", "user-1"]);
  });

  it("scopes the update to whichever user the session resolves to, even with attacker-supplied ids", async () => {
    const { POST, calls } = await loadRoute({
      userId: "user-2",
      supabase: { userbase_notifications: [{ data: null, error: null }] },
    });

    await POST(req({ ids: ["someone-elses-notification"] }));

    const eqCall = calls.find((c) => c.table === "userbase_notifications" && c.method === "eq");
    expect(eqCall?.args).toEqual(["user_id", "user-2"]);
  });

  it("500s when the backend isn't configured", async () => {
    vi.doMock("@/app/utils/supabase/supabaseClient", () => ({ supabaseAdmin: null }));
    vi.doMock("@/lib/userbase/session", () => ({ resolveUserbaseUserId: vi.fn(async () => "user-1") }));
    vi.resetModules();
    const { POST } = await import("./route");
    const res = await POST(req({ all: true }));
    expect(res.status).toBe(500);
  });
});
