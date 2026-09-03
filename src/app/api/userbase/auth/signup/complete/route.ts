import { NextRequest, NextResponse } from "next/server";
import { verifySignupToken } from "@/lib/userbase/signupToken";
import {
  validateHiveUsernameFormat,
  checkHiveAccountExists,
} from "@/lib/userbase/hiveAccount";
import { createSession, getUserPublic } from "@/lib/userbase/session";
import { supabaseAdmin } from "@/app/utils/supabase/supabaseClient";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { success: false, error: "Userbase backend not configured" },
      { status: 500 }
    );
  }
  const body = await req.json().catch(() => null);
  const signupToken = String(body?.signupToken || "");
  const handle = String(body?.handle || "").trim().toLowerCase();
  const displayName = body?.display_name ? String(body.display_name).trim() : null;

  const verified = verifySignupToken(signupToken);
  if (!verified) {
    return NextResponse.json(
      { success: false, error: "Signup session expired — request a new code" },
      { status: 401 }
    );
  }
  const email = verified.email;

  const fmt = validateHiveUsernameFormat(handle);
  if (!fmt.isValid) {
    return NextResponse.json({ success: false, error: fmt.error }, { status: 400 });
  }

  // Must be claimable on Hive (not already an on-chain account).
  let existsOnChain: boolean;
  try {
    existsOnChain = await checkHiveAccountExists(handle);
  } catch {
    return NextResponse.json(
      { success: false, error: "Couldn't verify username availability — try again" },
      { status: 503 }
    );
  }
  if (existsOnChain) {
    return NextResponse.json(
      { success: false, error: "That Hive username is already taken", code: "hive_taken" },
      { status: 409 }
    );
  }

  // If the email got registered meanwhile (double-submit), just log in.
  const { data: existing } = await supabaseAdmin
    .from("userbase_auth_methods")
    .select("user_id")
    .eq("type", "email_magic")
    .eq("identifier", email)
    .limit(1);
  if (existing?.[0]) {
    const uid = existing[0].user_id;
    const { token, expiresAt } = await createSession(uid, req.headers.get("user-agent"));
    return NextResponse.json({
      success: true,
      token,
      expires_at: expiresAt,
      user: await getUserPublic(uid),
    });
  }

  // Handle already used inside userbase?
  const { data: handleTaken } = await supabaseAdmin
    .from("userbase_users")
    .select("id")
    .eq("handle", handle)
    .limit(1);
  if (handleTaken?.[0]) {
    return NextResponse.json(
      { success: false, error: "That username is already in use", code: "userbase_taken" },
      { status: 409 }
    );
  }

  // Create account + email auth method.
  const { data: created, error: userErr } = await supabaseAdmin
    .from("userbase_users")
    .insert({
      handle,
      display_name: displayName,
      avatar_url: null,
      status: "active",
      onboarding_step: 0,
    })
    .select("id")
    .single();
  if (userErr || !created) {
    // Unique-violation: another signup claimed this handle between our check
    // above and this insert (TOCTOU). The DB constraint is the source of truth.
    if ((userErr as { code?: string } | null)?.code === "23505") {
      return NextResponse.json(
        { success: false, error: "That username is already in use", code: "userbase_taken" },
        { status: 409 }
      );
    }
    console.error("[signup/complete] user insert failed", userErr);
    return NextResponse.json(
      { success: false, error: "Could not create the account" },
      { status: 500 }
    );
  }
  const userId = created.id;

  const { error: amErr } = await supabaseAdmin.from("userbase_auth_methods").insert({
    user_id: userId,
    type: "email_magic",
    identifier: email,
    created_at: new Date().toISOString(),
  });
  if (amErr) {
    console.error("[signup/complete] auth method insert failed", amErr);
    return NextResponse.json(
      { success: false, error: "Could not link the email to the account" },
      { status: 500 }
    );
  }

  const { token, expiresAt } = await createSession(userId, req.headers.get("user-agent"));
  return NextResponse.json({
    success: true,
    token,
    expires_at: expiresAt,
    user: await getUserPublic(userId),
  });
}
