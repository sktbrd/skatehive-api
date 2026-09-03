import { NextRequest, NextResponse } from "next/server";
import { PrivateKey } from "@hiveio/dhive";
import {
  verifySignupToken,
  isSignupTokenConsumed,
  markSignupTokenConsumed,
} from "@/lib/userbase/signupToken";
import { validateHiveUsernameFormat } from "@/lib/userbase/hiveAccount";
import { fetchAccountInfo } from "@/app/utils/hive/hiveUtils";
import { encryptHivePostingKey } from "@/lib/userbase/encryption";
import { createSession, getUserPublic } from "@/lib/userbase/session";
import { isRateLimited, recordAttempt, getClientIp } from "@/lib/userbase/rateLimit";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";

export const runtime = "nodejs";

const EMAIL_LIMIT = 5;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 20;
const IP_WINDOW_MS = 60 * 60 * 1000;

function fail(
  status: number,
  code: string,
  error: string,
  extra?: { ip?: string; email?: string | null }
) {
  if (extra) {
    if (extra.ip) recordAttempt(`ip:${extra.ip}`, IP_WINDOW_MS);
    if (extra.email) recordAttempt(`email:${extra.email}`, EMAIL_WINDOW_MS);
  }
  return NextResponse.json({ success: false, error, code }, { status });
}

// Claim an existing Hive account during email signup: proves ownership via
// the account's posting key, then attaches the email as a login method
// (creating the userbase user + identity if this is the first time we've
// seen this Hive handle). Custody of the key moves to the server, mirroring
// the web app's keys/posting route (see that route for the key_auths check
// this ports).
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { success: false, error: "Userbase backend not configured", code: "server_error" },
      { status: 500 }
    );
  }

  const ip = getClientIp(req);
  if (isRateLimited(`ip:${ip}`, IP_LIMIT, IP_WINDOW_MS)) {
    return fail(429, "rate_limited", "Too many attempts, try again later");
  }

  const body = await req.json().catch(() => null);
  const signupToken = String(body?.signupToken || "");
  const handle = String(body?.handle || "").trim().toLowerCase();
  const postingKeyRaw = String(body?.postingKey || "").trim();

  const verified = verifySignupToken(signupToken);
  if (!verified || isSignupTokenConsumed(signupToken)) {
    return fail(401, "expired_token", "Signup session expired — request a new code", { ip });
  }
  const email = verified.email;

  if (isRateLimited(`email:${email}`, EMAIL_LIMIT, EMAIL_WINDOW_MS)) {
    return fail(429, "rate_limited", "Too many attempts, try again later");
  }

  const fmt = validateHiveUsernameFormat(handle);
  if (!fmt.isValid) {
    return fail(400, "invalid_handle", fmt.error || "Invalid handle", { ip, email });
  }

  let publicKey: string;
  try {
    publicKey = PrivateKey.fromString(postingKeyRaw).createPublic().toString();
  } catch {
    return fail(400, "invalid_key", "That key doesn't match @" + handle, { ip, email });
  }

  let account: Awaited<ReturnType<typeof fetchAccountInfo>>;
  try {
    account = await fetchAccountInfo(handle);
  } catch {
    return fail(503, "chain_unavailable", "Couldn't reach Hive, try again", { ip, email });
  }
  if (!account) {
    return fail(400, "invalid_key", "That key doesn't match @" + handle, { ip, email });
  }

  // Honour weight_threshold, not just key membership: a single key only
  // proves posting authority if its own weight clears the threshold (we
  // never have more than one key to combine).
  const posting = account.posting;
  const weightThreshold = Number(posting?.weight_threshold ?? 1);
  const matchedWeight = (posting?.key_auths || [])
    .filter((entry) => String(entry[0]) === publicKey)
    .reduce((sum, entry) => sum + Number(entry[1]), 0);
  if (matchedWeight < weightThreshold) {
    return fail(400, "invalid_key", "That key doesn't match @" + handle, { ip, email });
  }

  // Identity lookup/creation happens BEFORE the email-binding check below, so
  // that check can be scoped to "bound to a DIFFERENT user" instead of "bound
  // to anyone" — we need to know which user_id this claim would land on first.
  const { data: existingIdentity } = await supabaseAdmin
    .from("userbase_identities")
    .select("id, user_id")
    .eq("type", "hive")
    .eq("handle", handle)
    .limit(1);

  let userId: string;
  if (existingIdentity?.[0]) {
    userId = existingIdentity[0].user_id;
  } else {
    const { data: createdUser, error: userErr } = await supabaseAdmin
      .from("userbase_users")
      .insert({
        handle,
        display_name: null,
        avatar_url: null,
        status: "active",
        onboarding_step: 0,
      })
      .select("id")
      .single();
    if (userErr || !createdUser) {
      if ((userErr as { code?: string } | null)?.code === "23505") {
        return fail(409, "userbase_taken", "That username is already in use", { ip, email });
      }
      console.error("[signup/claim] user insert failed", userErr);
      return fail(500, "server_error", "Could not create the account", { ip, email });
    }
    const newUserId = createdUser.id;

    const { error: identityErr } = await supabaseAdmin.from("userbase_identities").insert({
      user_id: newUserId,
      type: "hive",
      handle,
      is_primary: true,
      created_at: new Date().toISOString(),
    });
    if (identityErr) {
      // Not atomic (no cross-table transaction from this app-level flow — see
      // the claim_hive_account_fn.sql migration for the atomic alternative,
      // not yet applied), so we compensate here instead of leaving an orphan
      // userbase_users row that would block this handle forever.
      if ((identityErr as { code?: string }).code === "23505") {
        // A concurrent claim won the identity race. Adopt its user_id and
        // clean up the user row we speculatively created.
        await supabaseAdmin.from("userbase_users").delete().eq("id", newUserId);
        const { data: raceIdentity } = await supabaseAdmin
          .from("userbase_identities")
          .select("id, user_id")
          .eq("type", "hive")
          .eq("handle", handle)
          .limit(1);
        if (!raceIdentity?.[0]) {
          console.error("[signup/claim] identity insert 23505 but re-lookup found nothing", identityErr);
          return fail(500, "server_error", "Could not link the Hive account", { ip, email });
        }
        userId = raceIdentity[0].user_id;
      } else {
        await supabaseAdmin.from("userbase_users").delete().eq("id", newUserId);
        console.error("[signup/claim] identity insert failed", identityErr);
        return fail(500, "server_error", "Could not link the Hive account", { ip, email });
      }
    } else {
      userId = newUserId;
    }
  }

  const { data: boundElsewhere } = await supabaseAdmin
    .from("userbase_auth_methods")
    .select("user_id")
    .eq("type", "email_magic")
    .eq("identifier", email)
    .limit(1);
  if (boundElsewhere?.[0] && boundElsewhere[0].user_id !== userId) {
    return fail(409, "merge_required", "This email is already used by another SkateHive account", {
      ip,
      email,
    });
  }
  const alreadyBoundToThisUser = Boolean(boundElsewhere?.[0] && boundElsewhere[0].user_id === userId);

  const encData = encryptHivePostingKey(postingKeyRaw, userId);
  const now = new Date().toISOString();

  const { error: keyErr } = await supabaseAdmin.from("userbase_hive_keys").upsert(
    {
      user_id: userId,
      hive_username: handle,
      encrypted_posting_key: encData.encryptedKey,
      encryption_iv: encData.iv,
      encryption_auth_tag: encData.authTag,
      key_type: "user_provided",
      // created_at intentionally omitted — an existing row's created_at must
      // not be clobbered on re-claim/re-submit; the DB default only applies
      // on first insert.
      updated_at: now,
    },
    { onConflict: "user_id" }
  );
  if (keyErr) {
    console.error("[signup/claim] hive key upsert failed", keyErr);
    return fail(500, "server_error", "Could not store the posting key", { ip, email });
  }

  if (!alreadyBoundToThisUser) {
    const { error: amErr } = await supabaseAdmin.from("userbase_auth_methods").insert({
      user_id: userId,
      type: "email_magic",
      identifier: email,
      created_at: now,
    });
    if (amErr) {
      if ((amErr as { code?: string }).code === "23505") {
        return fail(409, "merge_required", "This email is already used by another SkateHive account", {
          ip,
          email,
        });
      }
      console.error("[signup/claim] auth method insert failed", amErr);
      return fail(500, "server_error", "Could not link the email to the account", { ip, email });
    }
  }

  let session: { token: string; expiresAt: string };
  try {
    session = await createSession(userId, req.headers.get("user-agent"));
  } catch (err) {
    console.error("[signup/claim] session creation failed", err);
    return fail(500, "server_error", "Could not create a session", { ip, email });
  }

  markSignupTokenConsumed(signupToken);

  return NextResponse.json({
    success: true,
    token: session.token,
    expires_at: session.expiresAt,
    user: await getUserPublic(userId),
  });
}
