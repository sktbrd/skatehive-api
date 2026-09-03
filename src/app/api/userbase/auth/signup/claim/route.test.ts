import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrivateKey } from "@hiveio/dhive";
import { makeFakeSupabase, type FakeResult } from "@/test/fakeSupabase";

process.env.USERBASE_KEY_ENCRYPTION_SECRET = "test-secret-for-vitest";

const RIGHT_KEY = PrivateKey.fromSeed("claim-route-test-seed");
const RIGHT_PUB = RIGHT_KEY.createPublic().toString();
const WRONG_KEY = PrivateKey.fromSeed("claim-route-wrong-seed");

const HANDLE = "tonyhawk";
const EMAIL = "skater@example.com";

function accountWithPosting(pub: string) {
  return { name: HANDLE, posting: { key_auths: [[pub, 1]] } };
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/userbase/auth/signup/claim", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function loadRoute(opts: {
  supabase?: Record<string, FakeResult[]>;
  fetchAccountInfo?: (handle: string) => Promise<any>;
}) {
  vi.doMock("@/app/utils/supabase/supabaseClient", () => ({
    supabaseAdmin: makeFakeSupabase(opts.supabase || {}),
  }));
  vi.doMock("@/app/utils/hive/hiveUtils", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/utils/hive/hiveUtils")>();
    return {
      ...actual,
      fetchAccountInfo:
        opts.fetchAccountInfo || vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    };
  });
  vi.resetModules();
  const { POST } = await import("./route");
  const { signSignupToken } = await import("@/lib/userbase/signupToken");
  return { POST, signSignupToken };
}

describe("POST /api/userbase/auth/signup/claim", () => {
  it("creates a new user + hive identity + hive_keys + auth method when no identity exists yet", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_identities: [{ data: [], error: null }],
        userbase_users: [
          { data: { id: "new-user-id" }, error: null },
          { data: [{ id: "new-user-id", handle: HANDLE }], error: null },
        ],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
      },
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.token).toEqual(expect.any(String));
    expect(json.user).toMatchObject({ id: "new-user-id" });
  });

  it("attaches the auth method to an existing hive identity without creating a new user", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_identities: [{ data: [{ id: "ident-1", user_id: "existing-user-id" }], error: null }],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
        userbase_users: [{ data: [{ id: "existing-user-id", handle: HANDLE }], error: null }],
      },
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.user).toMatchObject({ id: "existing-user-id" });
  });

  it("400s with code=invalid_key when the posting key does not match the account", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: WRONG_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, code: "invalid_key" });
  });

  it("401s with code=expired_token for an invalid or expired signup token", async () => {
    const { POST } = await loadRoute({});

    const res = await POST(req({ signupToken: "not-a-real-token", handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, code: "expired_token" });
  });

  it("409s with code=merge_required when the email is already bound to a different user", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_auth_methods: [{ data: [{ user_id: "some-other-user" }], error: null }],
      },
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ success: false, code: "merge_required" });
  });

  it("429s with code=rate_limited on the 6th attempt for the same email within the window", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);
    const badBody = { signupToken: token, handle: HANDLE, postingKey: WRONG_KEY.toString() };

    let lastRes;
    for (let i = 0; i < 5; i++) {
      lastRes = await POST(req(badBody));
      expect(lastRes.status).toBe(400); // each attempt fails on the mismatched key
    }
    const sixth = await POST(req(badBody));
    const json = await sixth.json();

    expect(sixth.status).toBe(429);
    expect(json).toMatchObject({ success: false, code: "rate_limited" });
  });
});
