-- Atomic version of the signup/claim write path (user + identity + hive_keys
-- + auth_method), written in response to a security review that flagged the
-- app-level version as non-atomic: a user insert can succeed while the
-- identity insert fails, leaving an orphan user row that permanently blocks
-- the handle (nothing else references it, so nothing ever cleans it up).
--
-- NOT applied. The claim route (src/app/api/userbase/auth/signup/claim/route.ts)
-- currently compensates for the same failure at the app level instead (delete
-- the orphan user on identity-insert failure; on a 23505 identity race,
-- re-adopt the winning identity's user_id and delete the orphan) — that works
-- today without a schema change. Once this function is applied, the route can
-- be simplified to a single `supabaseAdmin.rpc('claim_hive_account', {...})`
-- call and the compensation logic can be deleted.
--
-- Does NOT touch userbase_auth_methods uniqueness decisions (bound-to-a-
-- different-user vs. double-submit) — the route still makes that call before
-- invoking this function, since it needs to choose between 409 merge_required
-- and "just log them in" *before* committing anything.

create or replace function public.claim_hive_account(
  p_handle text,
  p_email text,
  p_encrypted_key text,
  p_encryption_iv text,
  p_encryption_auth_tag text
) returns table (user_id uuid, created boolean) as $$
declare
  v_user_id uuid;
  v_created boolean := false;
begin
  select ui.user_id into v_user_id
  from public.userbase_identities ui
  where ui.type = 'hive' and ui.handle = p_handle
  limit 1;

  if v_user_id is null then
    insert into public.userbase_users (handle, display_name, avatar_url, status, onboarding_step)
    values (p_handle, null, null, 'active', 0)
    returning id into v_user_id;

    insert into public.userbase_identities (user_id, type, handle, is_primary, created_at)
    values (v_user_id, 'hive', p_handle, true, now());

    v_created := true;
  end if;

  -- created_at is intentionally omitted from the conflict update so an
  -- existing row's original created_at is never overwritten.
  insert into public.userbase_hive_keys
    (user_id, hive_username, encrypted_posting_key, encryption_iv, encryption_auth_tag, key_type, updated_at)
  values
    (v_user_id, p_handle, p_encrypted_key, p_encryption_iv, p_encryption_auth_tag, 'user_provided', now())
  on conflict (user_id) do update set
    hive_username = excluded.hive_username,
    encrypted_posting_key = excluded.encrypted_posting_key,
    encryption_iv = excluded.encryption_iv,
    encryption_auth_tag = excluded.encryption_auth_tag,
    key_type = excluded.key_type,
    updated_at = excluded.updated_at;

  begin
    insert into public.userbase_auth_methods (user_id, type, identifier, created_at)
    values (v_user_id, 'email_magic', p_email, now());
  exception when unique_violation then
    -- Already attached to this same user (double-submit) — the route's own
    -- pre-check already ruled out "bound to someone else" before calling
    -- this function, so a conflict here just means we lost a race against
    -- ourselves. Not an error.
    null;
  end;

  return query select v_user_id, v_created;
end;
$$ language plpgsql;
