-- ============================================================
-- Larsa Control — Admin role accounting parity tests, migration 021.
--
-- Rules under test: acct_role_default_perms, acct_check_entry_scope, and
-- acct_check_actor all now treat the "Admin" role exactly like "Owner /
-- Super Admin" -- full write/approve/reject/reopen/export/payroll
-- capability, the same project-assignment bypass, the same ability to
-- record progress -- while deliberately NOT granting self_approve or
-- manage_permissions by role default, because Owner / Super Admin does
-- not get those from role defaults either (they are individually granted
-- via acct_set_permissions, even for the owner). A role with strictly
-- less than Owner / Super Admin, like Accountant, must still be rejected
-- by the entry-scope check when it is not on a project's assigned-
-- accountants list -- the control case proving the Admin bypass is
-- actually role-specific and not a blanket "everyone passes".
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.chk(label text, ok boolean)
returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;

do $$
declare
  admin_actor    jsonb := '{"email":"admin.promoted@larsaeng.com","name":"Promoted Admin","role":"Admin"}'::jsonb;
  owner_actor    jsonb := '{"email":"owner3@larsaeng.com","name":"Owner","role":"Owner / Super Admin"}'::jsonb;
  clerk_actor    jsonb := '{"email":"clerk3@larsaeng.com","name":"Assigned Clerk","role":"Accountant"}'::jsonb;
  outsider_actor jsonb := '{"email":"outsider@larsaeng.com","name":"Unassigned Accountant","role":"Accountant"}'::jsonb;
  admin_perms text[];
  owner_perms text[];
  r jsonb;
begin
  -- ----------------------------------------------------------
  -- 1. acct_role_default_perms: Admin is identical to Owner / Super
  --    Admin, and neither carries self_approve or manage_permissions
  --    from role defaults alone.
  -- ----------------------------------------------------------
  select array_agg(x order by x) into admin_perms from unnest(public.acct_role_default_perms('Admin')) x;
  select array_agg(x order by x) into owner_perms from unnest(public.acct_role_default_perms('Owner / Super Admin')) x;
  perform pg_temp.chk('Admin''s default accounting permissions are identical to Owner / Super Admin''s',
    admin_perms = owner_perms);
  perform pg_temp.chk('Admin''s role defaults include full write/approve/export/payroll capability',
    'create' = any(admin_perms) and 'approve' = any(admin_perms) and 'reject' = any(admin_perms)
    and 'reopen_approved' = any(admin_perms) and 'export_approved' = any(admin_perms)
    and 'payroll_manage' = any(admin_perms) and 'payroll_configure' = any(admin_perms));
  perform pg_temp.chk('Admin does not get self_approve or manage_permissions from role defaults (neither does Owner)',
    not ('self_approve' = any(admin_perms)) and not ('manage_permissions' = any(admin_perms))
    and not ('self_approve' = any(owner_perms)) and not ('manage_permissions' = any(owner_perms)));

  -- ----------------------------------------------------------
  -- 2. acct_post_transaction (via acct_check_perm -> acct_has_perm ->
  --    acct_role_default_perms): Admin can enter data, and -- exactly
  --    like Owner / Super Admin -- entering it does not also approve
  --    it: a directly-"posted" submission still lands PENDING APPROVAL,
  --    because neither role holds the separately-granted self_approve
  --    permission.
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(owner_actor, '{"id":"admparity1","name":"Admin Parity Test Project","currency":"IQD"}'::jsonb);

  r := public.acct_post_transaction(admin_actor, '{"project_id":"admparity1","kind":"expense","category":"Site Costs",
        "amount":50000,"currency":"IQD","status":"posted","description":"admin-entered expense"}'::jsonb);
  perform pg_temp.chk('a promoted Admin can post an accounting entry at all (acct_check_perm allows create)',
    (r->'txn'->>'id') is not null);
  perform pg_temp.chk('an Admin''s directly-"posted" entry is forced to PENDING, same as Owner / Super Admin would be',
    (r->'txn'->>'status') = 'pending' and coalesce((r->>'entered_pending')::boolean,false));

  -- ----------------------------------------------------------
  -- 3. acct_check_entry_scope: Admin bypasses a project's assigned-
  --    accountants restriction, same as Owner / Super Admin -- while an
  --    ordinary Accountant NOT on that project's assignment list is
  --    still correctly rejected (the control case).
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(owner_actor, jsonb_build_object(
    'id','admparity2','name','Admin Parity Scoped Project','currency','IQD',
    'assigned_accountants', jsonb_build_array('clerk3@larsaeng.com')));

  r := public.acct_post_transaction(admin_actor, '{"project_id":"admparity2","kind":"expense","category":"Site Costs",
        "amount":10000,"currency":"IQD","description":"admin entering an assignment-scoped project"}'::jsonb);
  perform pg_temp.chk('Admin enters data on a project scoped to someone else''s assignment, same bypass as Owner / Super Admin',
    (r->'txn'->>'id') is not null);

  r := public.acct_post_transaction(clerk_actor, '{"project_id":"admparity2","kind":"expense","category":"Site Costs",
        "amount":10000,"currency":"IQD","description":"the actually-assigned clerk"}'::jsonb);
  perform pg_temp.chk('the actually-assigned accountant can still enter data on their own scoped project',
    (r->'txn'->>'id') is not null);

  begin
    r := public.acct_post_transaction(outsider_actor, '{"project_id":"admparity2","kind":"expense","category":"Site Costs",
          "amount":10000,"currency":"IQD","description":"should be rejected"}'::jsonb);
    raise exception 'FAIL: an unassigned Accountant entered data on a project scoped to someone else';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an ordinary Accountant NOT on the assignment list is still rejected -- proves the Admin bypass is role-specific, not universal',
      sqlerrm like '%ACCT_SCOPE%' or sqlerrm like '%assigned to%');
  end;

  -- ----------------------------------------------------------
  -- 4. acct_check_actor's 'progress' branch: Admin may record schedule
  --    progress, same as Owner / Super Admin.
  -- ----------------------------------------------------------
  r := public.acct_record_progress(admin_actor, 'admparity1', 42.5, current_date, 'admin progress update');
  perform pg_temp.chk('a promoted Admin may record project progress',
    (r->'progress'->>'id') is not null);

  raise notice 'ALL ADMIN ROLE PARITY SQL TESTS PASSED';
end $$;

select 'ADMIN ROLE PARITY SQL TESTS COMPLETE' as done;
rollback;
