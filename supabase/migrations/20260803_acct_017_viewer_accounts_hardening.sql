-- ============================================================
-- Larsa Control — close two gaps the security advisor caught in
-- 20260803_acct_016_viewer_accounts.sql, before this ships:
--
-- 1. is_any_viewer, viewer_can_read_project, and account_audit_log were
--    left at Postgres's default grants, which hand EXECUTE to PUBLIC —
--    including the bare `anon` role (a request carrying only the public
--    anon API key, no session at all). Every other function in this
--    project that a client is meant to call after signing in follows the
--    same shape: revoke from anon, grant only to authenticated (see
--    acct_compute_refund, acct_project_summary, acct_request_protected,
--    and 68 others in the earlier migrations). These three were simply
--    missed. Fixing it changes nothing for a real employee session
--    (anonymous-but-authenticated) or a real Viewer session (a genuine
--    Supabase Auth sign-in, also `authenticated`) — both already carry
--    the authenticated role today. It only removes the ability to call
--    these three straight from the public anon key with no session at
--    all, which the app itself never does.
--
-- 2. app_state_guard_super_admin (the trigger function protecting the
--    Super Admin account) was the one function in that migration missing
--    `set search_path`, so its unqualified references could in principle
--    resolve against a search_path an attacker had altered. Every other
--    function in the migration already pins this; this one was an
--    oversight, not a decision.
-- ============================================================

revoke all on function public.is_any_viewer(uuid) from public, anon;
grant execute on function public.is_any_viewer(uuid) to authenticated;

revoke all on function public.viewer_can_read_project(uuid, text) from public, anon;
grant execute on function public.viewer_can_read_project(uuid, text) to authenticated;

revoke all on function public.account_audit_log(jsonb, text, text, text, text, jsonb) from public, anon;
grant execute on function public.account_audit_log(jsonb, text, text, text, text, jsonb) to authenticated;

create or replace function public.app_state_guard_super_admin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  old_admins jsonb;
  new_admins jsonb;
  rec jsonb;
begin
  if new.store_key <> 'larsaStaffV8' or TG_OP <> 'UPDATE' then
    return new;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', u->>'id', 'email', lower(coalesce(u->>'email','')))), '[]'::jsonb)
    into old_admins
    from jsonb_array_elements(coalesce(old.data->'users', '[]'::jsonb)) u
   where u->>'access' = 'Super Admin';

  select coalesce(jsonb_agg(jsonb_build_object('id', u->>'id', 'email', lower(coalesce(u->>'email','')))), '[]'::jsonb)
    into new_admins
    from jsonb_array_elements(coalesce(new.data->'users', '[]'::jsonb)) u
   where u->>'access' = 'Super Admin';

  for rec in select * from jsonb_array_elements(new_admins)
  loop
    if not exists (select 1 from jsonb_array_elements(old_admins) o where o->>'id' = rec->>'id') then
      raise exception 'ACCOUNT_GUARD: this write would grant Super Admin to user id=% who was not already Super Admin — rejected', rec->>'id';
    end if;
  end loop;

  for rec in select * from jsonb_array_elements(old_admins)
  loop
    if not exists (select 1 from jsonb_array_elements(new_admins) n where n->>'id' = rec->>'id' and n->>'email' = rec->>'email') then
      raise exception 'ACCOUNT_GUARD: this write would remove or modify the protected Super Admin account id=% — rejected', rec->>'id';
    end if;
  end loop;

  return new;
end;
$$;
