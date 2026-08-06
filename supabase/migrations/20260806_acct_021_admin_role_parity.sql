-- ============================================================
-- Larsa Control — Accounting upgrade, part 21: Admin role parity
--
-- The owner asked for a promotable "Admin" staff role that can do
-- essentially everything the Super Admin can, EXCEPT ever touching the
-- single protected Super Admin account itself (that lock lives entirely
-- outside accounting — see app_state_guard_super_admin in
-- 20260803_acct_016_viewer_accounts.sql and the account-deletion /
-- role-dropdown guards in app/page.tsx, none of which this migration
-- changes). This file is the accounting half of that: it teaches the
-- database, not just the client, to recognize "Admin" as a role string
-- carrying the same weight as "Owner / Super Admin".
--
-- Client-side (app/page.tsx, public/engines/accounting.html,
-- public/engines/accounting-cloud.js) already sends the exact string
-- "Admin" as accountingRole(user) for a promoted Admin — a deliberately
-- NEW, distinct role rather than a reuse of "Owner / Super Admin", so it
-- reads correctly in audit trails and never collides with the couple of
-- legacy client checks that test for that literal substring. But the
-- client's own permission object is not what is enforced: every table in
-- this schema revokes direct INSERT/UPDATE/DELETE from anon/authenticated
-- (see 20260801_acct_001_core_tables.sql), so every write goes through a
-- SECURITY DEFINER RPC, and those RPCs decide who may act by re-checking
-- the actor's role SERVER-SIDE. Without this migration, a promoted Admin's
-- UI would light up as if they had full accounting access, and every
-- write would then be rejected by the database. This migration is what
-- makes the grant real.
--
-- Four functions carry role-string logic; every other write/approve/edit
-- RPC (acct_post_transaction, acct_update_transaction, acct_set_txn_status,
-- acct_soft_delete, acct_restore_record, acct_upsert_project,
-- acct_resolve_review, ...) delegates to these rather than checking a role
-- string itself, so patching these four is sufficient:
--
--   1. acct_role_default_perms(p_role) — the actual source of truth for
--      what a role can do (view/create/edit/approve/reject/reopen/export/
--      payroll...). acct_has_perm, acct_check_perm, acct_check_actor's
--      'write' branch, and acct_get_my_permissions all read through this,
--      so adding "Admin" here is what makes create/edit/approve/reject/
--      export/payroll capability real for the role. Deliberately NOT
--      given 'self_approve' or 'manage_permissions' — "Owner / Super
--      Admin" and "Management" do not get those from role defaults
--      either; the maker-checker design (20260802_acct_007) requires
--      those to be individually granted through acct_set_permissions
--      even for the owner, so leaving them out for Admin is true parity,
--      not a gap.
--   2. acct_check_entry_scope — the one place a role gets a hardcoded
--      bypass outside the permission-key system: when a project has
--      assigned accountants, only they (or "Owner / Super Admin") may
--      enter data for it. Admin joins that bypass, matching Super Admin.
--   3. acct_check_actor — its 'progress' branch hard-codes a role list
--      rather than reading acct_role_default_perms directly. Technically
--      the acct_has_perm(actor,'create') fallback already covers Admin
--      once (1) is applied, but the explicit list is kept in sync anyway
--      so the intent stays readable and doesn't quietly depend on that
--      fallback.
--   4. acct_writer_roles() — superseded by the granular acct_permissions
--      system in 20260802_acct_006 (nothing in a live code path still
--      calls it) but kept in sync so it never becomes a misleading trap
--      for future code that assumes it is authoritative.
--
-- Additive only, per this schema's own established convention (see the
-- header of 20260803_acct_009_payroll.sql): every function below is
-- replaced with create or replace using its full current body plus the
-- one addition each needs. Nothing is dropped, no table or column is
-- touched, no existing row changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. acct_role_default_perms — the load-bearing change. Full body as of
--    20260803_acct_009_payroll.sql, with 'Admin' added to the top branch.
-- ------------------------------------------------------------
create or replace function public.acct_role_default_perms(p_role text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_role in ('Owner / Super Admin','Management','Admin') then
      array['view','create','edit_own_unapproved','edit_any_unapproved','submit_review','review','approve','reject',
            'print_receipts','reprint_receipts','post_refunds','approve_refunds','reopen_approved',
            'export_working','export_approved',
            'payroll_manage','payroll_approve','payroll_pay','payroll_view_all','payroll_publish','payroll_configure']
    when p_role = 'Accountant' then
      array['view','create','edit_own_unapproved','submit_review','print_receipts','reprint_receipts','post_refunds','export_working',
            'payroll_manage','payroll_view_all','payroll_pay','payroll_publish']
    when p_role = 'Payroll Accountant' then
      -- Enters and pays payroll, and sees the employee records needed to do
      -- it. Deliberately no payroll_approve: the person who prepares a run is
      -- not the person who approves it.
      array['view','export_working',
            'payroll_manage','payroll_view_all','payroll_pay','payroll_publish']
    when p_role in ('Project Manager','Construction Engineer') then
      array['view']
    else array['view']
  end;
$$;

-- ------------------------------------------------------------
-- 2. acct_check_entry_scope — full body as of 20260802_acct_007_maker_checker.sql,
--    with 'Admin' added to the Owner / Super Admin bypass.
-- ------------------------------------------------------------
create or replace function public.acct_check_entry_scope(actor jsonb, p_project_id text)
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  proj record;
begin
  select assigned_accountants, assigned_approvers, name into proj
    from public.acct_projects where id = p_project_id;
  if proj is null then return; end if;
  if jsonb_array_length(coalesce(proj.assigned_accountants,'[]'::jsonb)) = 0 then return; end if;
  if public.acct_email_in_list(a_email, proj.assigned_accountants)
     or public.acct_email_in_list(a_email, proj.assigned_approvers)
     or coalesce(actor->>'role','') = 'Owner / Super Admin'
     or coalesce(actor->>'role','') = 'Admin' then
    return;
  end if;
  raise exception 'ACCT_SCOPE: data entry for project "%" is assigned to: % — ask an assigned accountant to record this entry',
    proj.name, (select string_agg(x, ', ') from jsonb_array_elements_text(proj.assigned_accountants) x);
end;
$$;

-- ------------------------------------------------------------
-- 3. acct_check_actor — full body as of 20260802_acct_006_review_receipts_permissions.sql
--    (the live version; it supersedes 20260801_acct_002's), with 'Admin'
--    added to the hardcoded 'progress' role list.
-- ------------------------------------------------------------
create or replace function public.acct_check_actor(actor jsonb, required text default 'write')
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  a_role  text := coalesce(actor->>'role','');
begin
  if a_email = '' or position('@' in a_email) = 0 then
    raise exception 'ACCT_ACTOR: a valid actor email is required';
  end if;
  if required = 'write' then
    perform public.acct_check_perm(actor, 'create');
  elsif required = 'progress' then
    if not (a_role = any (array['Owner / Super Admin','Management','Accountant','Admin','Project Manager','Construction Engineer'])
            or public.acct_has_perm(actor, 'create')) then
      raise exception 'ACCT_FORBIDDEN: role "%" cannot record progress', a_role;
    end if;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 4. acct_writer_roles() — kept in sync even though no live code path
--    still calls it (superseded by acct_check_perm / acct_has_perm /
--    acct_role_default_perms). Body as of 20260801_acct_002_engine_functions.sql,
--    PLUS the search_path pin that 20260801_acct_005_pin_search_paths.sql
--    added afterward via a separate ALTER FUNCTION -- create or replace
--    does not preserve a config parameter set by an earlier ALTER unless
--    the replacement statement specifies it again, so it is carried
--    forward here explicitly rather than silently dropped.
-- ------------------------------------------------------------
create or replace function public.acct_writer_roles()
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$ select array['Owner / Super Admin','Management','Accountant','Admin'] $$;
