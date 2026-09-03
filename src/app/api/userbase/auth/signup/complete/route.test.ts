import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { makeFakeSupabase } from "@/test/fakeSupabase";

vi.mock("@/lib/userbase/signupToken", () => ({
  verifySignupToken: vi.fn(() => ({ email: "skater@example.com" })),
}));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/userbase/auth/signup/complete", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/userbase/auth/signup/complete", () => {
  it("409s with code=hive_taken when the handle already exists on chain", async () => {
    vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
      supabaseAdmin: makeFakeSupabase({}),
    }));
    vi.doMock("@/lib/userbase/hiveAccount", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/userbase/hiveAccount")>();
      return { ...actual, checkHiveAccountExists: vi.fn(async () => true) };
    });
    vi.resetModules();
    const { POST } = await import("./route");

    const res = await POST(req({ signupToken: "t", handle: "tonyhawk" }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({
      success: false,
      code: "hive_taken",
      error: "That Hive username is already taken",
    });
  });

  it("409s with code=userbase_taken when the handle is already used in userbase", async () => {
    vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
      supabaseAdmin: makeFakeSupabase({
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_users: [{ data: [{ id: "existing-user" }], error: null }],
      }),
    }));
    vi.doMock("@/lib/userbase/hiveAccount", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/userbase/hiveAccount")>();
      return { ...actual, checkHiveAccountExists: vi.fn(async () => false) };
    });
    vi.resetModules();
    const { POST } = await import("./route");

    const res = await POST(req({ signupToken: "t", handle: "freshname" }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({
      success: false,
      code: "userbase_taken",
      error: "That username is already in use",
    });
  });
});
