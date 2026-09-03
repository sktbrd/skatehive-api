import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrivateKey } from "@hiveio/dhive";
import { makeFakeSupabase, type FakeCall, type FakeResult } from "@/test/fakeSupabase";
import { decryptHivePostingKey } from "@/lib/userbase/encryption";

process.env.USERBASE_KEY_ENCRYPTION_SECRET = "test-secret-for-vitest";

const RIGHT_KEY = PrivateKey.fromSeed("claim-route-test-seed");
const RIGHT_PUB = RIGHT_KEY.createPublic().toString();
const WRONG_KEY = PrivateKey.fromSeed("claim-route-wrong-seed");

const HANDLE = "tonyhawk";
const EMAIL = "skater@example.com";

function accountWithPosting(pub: string, weight = 1, weightThreshold = 1) {
  return { name: HANDLE, posting: { key_auths: [[pub, weight]], weight_threshold: weightThreshold } };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/userbase/auth/signup/claim", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.5", ...headers },
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
  const { supabaseAdmin } = await import("@/app/utils/supabase/supabaseClient");
  return { POST, signSignupToken, calls: (supabaseAdmin as any).calls as FakeCall[] };
}

function callsFor(calls: FakeCall[], table: string, method: string) {
  return calls.filter((c) => c.table === table && c.method === method);
}

describe("POST /api/userbase/auth/signup/claim", () => {
  it("creates a new user + hive identity + hive_keys + auth method when no identity exists yet", async () => {
    const { POST, signSignupToken, calls } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [], error: null }],
        userbase_users: [
          { data: { id: "new-user-id" }, error: null },
          { data: [{ id: "new-user-id", handle: HANDLE }], error: null },
        ],
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
      },
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.user).toMatchObject({ id: "new-user-id" });

    // exactly one user created
    expect(callsFor(calls, "userbase_users", "insert")).toHaveLength(1);

    // identity created as primary
    const identityInsert = callsFor(calls, "userbase_identities", "insert")[0];
    expect(identityInsert.args[0]).toMatchObject({ user_id: "new-user-id", type: "hive", is_primary: true });

    // key encrypted per-user (decrypts with the userId that owns it) and key_type set
    const keyUpsert = callsFor(calls, "userbase_hive_keys", "upsert")[0];
    expect(keyUpsert.args[0]).toMatchObject({ user_id: "new-user-id", key_type: "user_provided" });
    expect(keyUpsert.args[0]).not.toHaveProperty("created_at"); // must not clobber an existing row's created_at
    const decrypted = decryptHivePostingKey(
      {
        encryptedKey: keyUpsert.args[0].encrypted_posting_key,
        iv: keyUpsert.args[0].encryption_iv,
        authTag: keyUpsert.args[0].encryption_auth_tag,
      },
      "new-user-id"
    );
    expect(decrypted).toBe(RIGHT_KEY.toString());
  });

  it("attaches the auth method to an existing hive identity without creating a new user", async () => {
    const { POST, signSignupToken, calls } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [{ id: "ident-1", user_id: "existing-user-id" }], error: null }],
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
        userbase_users: [{ data: [{ id: "existing-user-id", handle: HANDLE }], error: null }],
      },
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.user).toMatchObject({ id: "existing-user-id" });
    expect(callsFor(calls, "userbase_users", "insert")).toHaveLength(0);
    expect(callsFor(calls, "userbase_auth_methods", "insert")).toHaveLength(1);
  });

  it("logs in without re-inserting the auth method when the email is already attached to this same account", async () => {
    const { POST, signSignupToken, calls } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [{ id: "ident-1", user_id: "existing-user-id" }], error: null }],
        userbase_auth_methods: [{ data: [{ user_id: "existing-user-id" }], error: null }],
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
    expect(callsFor(calls, "userbase_auth_methods", "insert")).toHaveLength(0);
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

  it("400s with code=invalid_key when the weighted key doesn't meet the account's weight_threshold", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB, 1, 2)),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, code: "invalid_key" });
  });

  it("400s with code=invalid_key for an account that doesn't exist on chain", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => null),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, code: "invalid_key" });
  });

  it("400s with code=invalid_key for a malformed (garbage) WIF, without ever calling the chain", async () => {
    const fetchAccountInfo = vi.fn(async () => accountWithPosting(RIGHT_PUB));
    const { POST, signSignupToken } = await loadRoute({ fetchAccountInfo });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: "not-a-real-wif" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, code: "invalid_key" });
    expect(fetchAccountInfo).not.toHaveBeenCalled();
  });

  it("503s with code=chain_unavailable when the Hive lookup throws", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => { throw new Error("rpc down"); }),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json).toMatchObject({ success: false, code: "chain_unavailable" });
  });

  it("401s with code=expired_token for an invalid or expired signup token", async () => {
    const { POST } = await loadRoute({});

    const res = await POST(req({ signupToken: "not-a-real-token", handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toMatchObject({ success: false, code: "expired_token" });
  });

  it("401s with code=expired_token when the same signup token is replayed after a successful claim", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [], error: null }],
        userbase_users: [
          { data: { id: "new-user-id" }, error: null },
          { data: [{ id: "new-user-id", handle: HANDLE }], error: null },
        ],
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
      },
    });
    const token = signSignupToken(EMAIL);

    const first = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    expect(first.status).toBe(200);

    const second = await POST(req({ signupToken: token, handle: "someoneelse", postingKey: RIGHT_KEY.toString() }));
    const json = await second.json();

    expect(second.status).toBe(401);
    expect(json).toMatchObject({ success: false, code: "expired_token" });
  });

  it("409s with code=merge_required when the email is already bound to a different user", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [{ id: "ident-1", user_id: "existing-user-id" }], error: null }],
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

  it("409s with code=userbase_taken when the handle is reserved by another (email) user", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [], error: null }],
        userbase_users: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
      },
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ success: false, code: "userbase_taken" });
  });

  it("409s with code=merge_required when the auth-method insert races another claim (23505)", async () => {
    const { POST, signSignupToken } = await loadRoute({
      supabase: {
        userbase_identities: [{ data: [{ id: "ident-1", user_id: "existing-user-id" }], error: null }],
        userbase_auth_methods: [
          { data: [], error: null }, // bound-elsewhere check: nobody yet
          { data: null, error: { code: "23505", message: "duplicate key" } }, // insert loses the race
        ],
        userbase_hive_keys: [{ data: null, error: null }],
      },
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);

    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ success: false, code: "merge_required" });
  });

  it("recovers from an identity-insert race (23505) by adopting the winning identity and deleting the orphan user", async () => {
    // userbase_identities calls, in order: initial select (nobody yet) ->
    // insert (loses the race to a concurrent claim) -> re-lookup select
    // (finds the winner).
    const { POST, signSignupToken, calls } = await loadRoute({
      supabase: {
        userbase_identities: [
          { data: [], error: null },
          { data: null, error: { code: "23505", message: "duplicate key" } },
          { data: [{ id: "ident-1", user_id: "winner-user-id" }], error: null },
        ],
        userbase_users: [
          { data: { id: "orphan-user-id" }, error: null }, // we create one...
          { data: [{ id: "winner-user-id", handle: HANDLE }], error: null }, // ...getUserPublic for the winner
        ],
        userbase_auth_methods: [{ data: [], error: null }],
        userbase_hive_keys: [{ data: null, error: null }],
        userbase_sessions: [{ data: null, error: null }],
      },
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });

    const token = signSignupToken(EMAIL);
    const res = await POST(req({ signupToken: token, handle: HANDLE, postingKey: RIGHT_KEY.toString() }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.user).toMatchObject({ id: "winner-user-id" });
    const deleteCalls = callsFor(calls, "userbase_users", "delete");
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(deleteCalls[0].args).toEqual([]); // .delete() itself takes no args; the eq() call carries the id
    const deleteEq = calls.find((c) => c.table === "userbase_users" && c.method === "eq" && c.args[1] === "orphan-user-id");
    expect(deleteEq).toBeTruthy();
  });

  it("429s with code=rate_limited on the 6th attempt for the same email within the window", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const token = signSignupToken(EMAIL);
    const badBody = { signupToken: token, handle: HANDLE, postingKey: WRONG_KEY.toString() };

    for (let i = 0; i < 5; i++) {
      const r = await POST(req(badBody, { "x-real-ip": "198.51.100.1" }));
      expect(r.status).toBe(400);
    }
    const sixth = await POST(req(badBody, { "x-real-ip": "198.51.100.1" }));
    const json = await sixth.json();

    expect(sixth.status).toBe(429);
    expect(json).toMatchObject({ success: false, code: "rate_limited" });
  });

  it("429s with code=rate_limited on the 21st attempt from the same IP, even across different emails", async () => {
    const { POST, signSignupToken } = await loadRoute({
      fetchAccountInfo: vi.fn(async () => accountWithPosting(RIGHT_PUB)),
    });
    const ip = "198.51.100.77";

    for (let i = 0; i < 20; i++) {
      const token = signSignupToken(`skater${i}@example.com`);
      const r = await POST(req({ signupToken: token, handle: HANDLE, postingKey: WRONG_KEY.toString() }, { "x-real-ip": ip }));
      expect(r.status).toBe(400);
    }
    const token = signSignupToken("one-more@example.com");
    const twentyFirst = await POST(req({ signupToken: token, handle: HANDLE, postingKey: WRONG_KEY.toString() }, { "x-real-ip": ip }));
    const json = await twentyFirst.json();

    expect(twentyFirst.status).toBe(429);
    expect(json).toMatchObject({ success: false, code: "rate_limited" });
  });
});
