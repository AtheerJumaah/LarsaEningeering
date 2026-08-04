-- ============================================================
-- Larsa Control — Viewer accounts: schema, RLS enforcement, the
-- Super Admin guard trigger, and the account audit log
-- (migrations acct_016, acct_017, acct_018).
-- Same harness as accounting-sql.test.sql; rolls back at the end.
-- ============================================================
\set ON_ERROR_STOP on
begin;
select set_config('acct.internal_op', '1', true);

create or replace function pg_temp.chk(label text, ok boolean)
returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;

do $$
declare
  viewer_a_uid uuid := gen_random_uuid();     -- assigned to prj-a only, enabled
  viewer_disabled_uid uuid := gen_random_uuid(); -- assigned to prj-a, disabled
  viewer_expired_uid uuid := gen_random_uuid();  -- assigned to prj-a, expired yesterday
  viewer_future_uid uuid := gen_random_uuid();   -- assigned to prj-a, expires tomorrow (not yet expired)
  viewer_all_uid uuid := gen_random_uuid();      -- project_access_mode = all
  viewer_none_uid uuid := gen_random_uuid();     -- project_access_mode = none
  stranger_uid uuid := gen_random_uuid();        -- a real auth.users row, never a viewer
  n int;
  r jsonb;
  keys text;
  ok boolean;
begin
  -- ----------------------------------------------------------
  -- Fixture: two projects, transactions and progress on both, and
  -- six viewer accounts covering every mode/enabled/expiry combination.
  -- ----------------------------------------------------------
  insert into public.acct_projects (id, code, name, client, region, type, status, currency)
  values
    ('zz-qa-viewer-prj-a', 'QA-A', 'QA Viewer Project A', 'QA Client', 'Erbil', 'Residential', 'Active', 'IQD'),
    ('zz-qa-viewer-prj-b', 'QA-B', 'QA Viewer Project B', 'QA Client 2', 'Duhok', 'Commercial', 'Active', 'IQD');

  insert into public.acct_transactions (txn_no, project_id, kind, txn_date, original_amount, original_currency, exchange_rate, amount_iqd, amount_usd)
  values
    ('ZZ-QA-TXN-A1', 'zz-qa-viewer-prj-a', 'funding', current_date, 5000000, 'IQD', 1310, 5000000, 3816.79),
    ('ZZ-QA-TXN-B1', 'zz-qa-viewer-prj-b', 'funding', current_date, 5000000, 'IQD', 1310, 5000000, 3816.79);

  insert into public.acct_progress_updates (project_id, percent, update_date, note)
  values
    ('zz-qa-viewer-prj-a', 40, current_date, 'QA progress note A'),
    ('zz-qa-viewer-prj-b', 60, current_date, 'QA progress note B');

  -- A row for the "an ordinary employee session is unaffected" check in
  -- section 3, below — this harness's app_state starts empty, unlike a real
  -- project which already has the larsaStaffV8/HR/accounting seed rows.
  insert into public.app_state (store_key, data) values ('zz-qa-unrelated-key', '{}'::jsonb);

  insert into auth.users (id, email) values
    (viewer_a_uid, 'zz-qa-viewer-a@viewer.larsaeng.internal'),
    (viewer_disabled_uid, 'zz-qa-viewer-disabled@viewer.larsaeng.internal'),
    (viewer_expired_uid, 'zz-qa-viewer-expired@viewer.larsaeng.internal'),
    (viewer_future_uid, 'zz-qa-viewer-future@viewer.larsaeng.internal'),
    (viewer_all_uid, 'zz-qa-viewer-all@viewer.larsaeng.internal'),
    (viewer_none_uid, 'zz-qa-viewer-none@viewer.larsaeng.internal'),
    (stranger_uid, 'zz-qa-not-a-viewer@viewer.larsaeng.internal');

  insert into public.viewer_accounts (auth_user_id, username, display_name, project_access_mode, allowed_project_ids, enabled, expires_at)
  values
    (viewer_a_uid, 'zz-qa-viewer-a', 'QA Viewer A', 'assigned', array['zz-qa-viewer-prj-a'], true, null),
    (viewer_disabled_uid, 'zz-qa-viewer-disabled', 'QA Viewer Disabled', 'assigned', array['zz-qa-viewer-prj-a'], false, null),
    (viewer_expired_uid, 'zz-qa-viewer-expired', 'QA Viewer Expired', 'assigned', array['zz-qa-viewer-prj-a'], true, now() - interval '1 day'),
    (viewer_future_uid, 'zz-qa-viewer-future', 'QA Viewer Future Expiry', 'assigned', array['zz-qa-viewer-prj-a'], true, now() + interval '1 day'),
    (viewer_all_uid, 'zz-qa-viewer-all', 'QA Viewer All', 'all', array[]::text[], true, null),
    (viewer_none_uid, 'zz-qa-viewer-none', 'QA Viewer None', 'none', array[]::text[], true, null);

  -- ----------------------------------------------------------
  -- Section 1: schema constraints
  -- ----------------------------------------------------------
  begin
    insert into public.viewer_accounts (auth_user_id, username, display_name, project_access_mode)
      values (stranger_uid, 'zz-qa-bad-mode', 'QA Bad Mode', 'everything');
    raise exception 'FAIL: an invalid project_access_mode was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('project_access_mode rejects a value outside all/assigned/none', true);
  end;

  begin
    insert into public.viewer_accounts (auth_user_id, username, display_name)
      values (stranger_uid, 'zz-qa-viewer-a', 'QA Duplicate Username');
    raise exception 'FAIL: a duplicate username was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('username has a real uniqueness constraint', true);
  end;

  select count(*) into n from public.viewer_accounts where auth_user_id = viewer_a_uid;
  perform pg_temp.chk('one viewer_accounts row exists per auth_user_id before the cascade test', n = 1);
  delete from auth.users where id = viewer_future_uid;
  select count(*) into n from public.viewer_accounts where auth_user_id = viewer_future_uid;
  perform pg_temp.chk('deleting the auth.users row cascades to remove the viewer_accounts row', n = 0);
  -- Restore it for the sections below that still need it.
  insert into auth.users (id, email) values (viewer_future_uid, 'zz-qa-viewer-future@viewer.larsaeng.internal');
  insert into public.viewer_accounts (auth_user_id, username, display_name, project_access_mode, allowed_project_ids, enabled, expires_at)
    values (viewer_future_uid, 'zz-qa-viewer-future', 'QA Viewer Future Expiry', 'assigned', array['zz-qa-viewer-prj-a'], true, now() + interval '1 day');

  -- ----------------------------------------------------------
  -- Section 2: is_any_viewer / viewer_can_read_project, called directly
  -- ----------------------------------------------------------
  perform pg_temp.chk('is_any_viewer is false for a uid nobody has heard of', public.is_any_viewer(gen_random_uuid()) = false);
  perform pg_temp.chk('is_any_viewer is true for a real viewer', public.is_any_viewer(viewer_a_uid) = true);
  perform pg_temp.chk('is_any_viewer is false for a real auth.users row that is not a viewer', public.is_any_viewer(stranger_uid) = false);

  perform pg_temp.chk('mode=all reads any project id', public.viewer_can_read_project(viewer_all_uid, 'zz-qa-viewer-prj-b') = true);
  perform pg_temp.chk('mode=assigned reads its own project', public.viewer_can_read_project(viewer_a_uid, 'zz-qa-viewer-prj-a') = true);
  perform pg_temp.chk('mode=assigned refuses a project not on its list', public.viewer_can_read_project(viewer_a_uid, 'zz-qa-viewer-prj-b') = false);
  perform pg_temp.chk('mode=none refuses every project, including its own scope list', public.viewer_can_read_project(viewer_none_uid, 'zz-qa-viewer-prj-a') = false);
  perform pg_temp.chk('a disabled viewer is refused even for its assigned project', public.viewer_can_read_project(viewer_disabled_uid, 'zz-qa-viewer-prj-a') = false);
  perform pg_temp.chk('an expired viewer is refused even for its assigned project', public.viewer_can_read_project(viewer_expired_uid, 'zz-qa-viewer-prj-a') = false);
  perform pg_temp.chk('a viewer expiring tomorrow is still allowed today', public.viewer_can_read_project(viewer_future_uid, 'zz-qa-viewer-prj-a') = true);
  perform pg_temp.chk('an unknown uid is refused for every project (fail closed)', public.viewer_can_read_project(gen_random_uuid(), 'zz-qa-viewer-prj-a') = false);

  -- ----------------------------------------------------------
  -- Section 3: RLS, exercised as the roles that actually hit these
  -- tables — a Viewer's own session, and an ordinary employee session.
  -- ----------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);

  select count(*) into n from public.acct_projects; perform pg_temp.chk('a scoped Viewer sees exactly one project through RLS, not both', n = 1);
  select count(*) into n from public.acct_projects where id = 'zz-qa-viewer-prj-a'; perform pg_temp.chk('...and it is the assigned one', n = 1);
  select count(*) into n from public.acct_transactions; perform pg_temp.chk('acct_transactions is scoped the same way', n = 1);
  select count(*) into n from public.acct_progress_updates; perform pg_temp.chk('acct_progress_updates is scoped the same way', n = 1);
  select count(*) into n from public.app_state; perform pg_temp.chk('a Viewer session reads zero app_state rows — the whole staff blob is closed', n = 0);
  select count(*) into n from public.acct_permissions; perform pg_temp.chk('a Viewer session reads zero acct_permissions rows', n = 0);
  select count(*) into n from public.acct_audit; perform pg_temp.chk('a Viewer session reads zero acct_audit rows', n = 0);

  begin
    insert into public.acct_projects (id, code, name) values ('zz-qa-viewer-hack', 'HACK', 'Should never land');
    raise exception 'FAIL: a Viewer session inserted a row into acct_projects';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a Viewer session cannot write to acct_projects (same revoke as every other authenticated session)', true);
  end;

  perform set_config('request.jwt.claim.sub', viewer_all_uid::text, true);
  select count(*) into n from public.acct_projects; perform pg_temp.chk('a mode=all Viewer sees both projects', n = 2);

  perform set_config('request.jwt.claim.sub', viewer_none_uid::text, true);
  select count(*) into n from public.acct_projects; perform pg_temp.chk('a mode=none Viewer sees zero projects', n = 0);

  -- An ordinary employee session: authenticated, but auth.uid() matches no
  -- viewer_accounts row at all (exactly like every real employee session
  -- today, which carries no auth.users identity in the first place). This is
  -- the "zero behaviour change" guarantee the restrictive policies promise.
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.acct_projects; perform pg_temp.chk('a non-viewer authenticated session still sees every project', n = 2);
  select count(*) into n from public.app_state; perform pg_temp.chk('a non-viewer authenticated session still reads app_state normally', n >= 1);
  reset role;

  -- ----------------------------------------------------------
  -- Section 4: viewer_project_summary — the one RPC a Viewer needs that
  -- table-level RLS alone cannot police (it wraps acct_project_summary,
  -- which trusts any caller for any project id).
  -- ----------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);
  r := public.viewer_project_summary('zz-qa-viewer-prj-a');
  perform pg_temp.chk('viewer_project_summary returns data for the assigned project', r is not null and r->>'project_id' = 'zz-qa-viewer-prj-a');
  select string_agg(k, ',') into keys from jsonb_object_keys(r) k;
  perform pg_temp.chk('...and never includes Larsa''s own revenue/profit/reliability fields',
    position('larsa_revenue' in keys) = 0 and position('company_net_profit' in keys) = 0
    and position('reliability' in keys) = 0 and position('revenue_iqd' in keys) = 0);
  perform pg_temp.chk('viewer_project_summary refuses a project outside this Viewer''s scope (returns null, not the data)',
    public.viewer_project_summary('zz-qa-viewer-prj-b') is null);

  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.chk('a non-viewer authenticated session gets null from viewer_project_summary (it is not the function they should use)',
    public.viewer_project_summary('zz-qa-viewer-prj-a') is null);
  reset role;

  -- ----------------------------------------------------------
  -- Section 5: grants — anon (no session at all) is shut out of every
  -- viewer-related function; authenticated (any signed-in session,
  -- employee or Viewer) can call them.
  -- ----------------------------------------------------------
  select has_function_privilege('anon', 'public.is_any_viewer(uuid)', 'execute') into ok;
  perform pg_temp.chk('anon cannot execute is_any_viewer', ok = false);
  select has_function_privilege('anon', 'public.viewer_can_read_project(uuid,text)', 'execute') into ok;
  perform pg_temp.chk('anon cannot execute viewer_can_read_project', ok = false);
  select has_function_privilege('anon', 'public.account_audit_log(jsonb,text,text,text,text,jsonb)', 'execute') into ok;
  perform pg_temp.chk('anon cannot execute account_audit_log', ok = false);
  select has_function_privilege('anon', 'public.viewer_project_summary(text)', 'execute') into ok;
  perform pg_temp.chk('anon cannot execute viewer_project_summary', ok = false);
  select has_function_privilege('authenticated', 'public.viewer_project_summary(text)', 'execute') into ok;
  perform pg_temp.chk('authenticated can execute viewer_project_summary', ok = true);

  -- ----------------------------------------------------------
  -- Section 6: app_state_guard_super_admin — the trigger that keeps a
  -- direct app_state write from minting or removing a Super Admin.
  -- ----------------------------------------------------------
  insert into public.app_state (store_key, data) values (
    'larsaStaffV8',
    '{"users":[{"id":"zz-qa-admin-1","email":"zz-qa-admin@larsaeng.com","access":"Super Admin"},{"id":"zz-qa-eng-1","email":"","access":"Engineer"}]}'::jsonb
  ) on conflict (store_key) do update set data = excluded.data;

  update public.app_state set data = '{"users":[{"id":"zz-qa-admin-1","email":"zz-qa-admin@larsaeng.com","access":"Super Admin"},{"id":"zz-qa-eng-1","email":"someone@larsaeng.com","access":"Manager"}]}'::jsonb
    where store_key = 'larsaStaffV8';
  perform pg_temp.chk('an unrelated app_state edit (admin untouched) is allowed', true);

  begin
    update public.app_state set data = '{"users":[{"id":"zz-qa-admin-1","email":"zz-qa-admin@larsaeng.com","access":"Engineer"}]}'::jsonb
      where store_key = 'larsaStaffV8';
    raise exception 'FAIL: demoting the only Super Admin was not blocked';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('demoting the existing Super Admin is blocked', sqlerrm like 'ACCOUNT_GUARD:%');
  end;

  begin
    update public.app_state set data = '{"users":[{"id":"zz-qa-admin-1","email":"zz-qa-admin@larsaeng.com","access":"Super Admin"},{"id":"zz-qa-eng-1","email":"someone@larsaeng.com","access":"Super Admin"}]}'::jsonb
      where store_key = 'larsaStaffV8';
    raise exception 'FAIL: minting a second Super Admin was not blocked';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('minting a second Super Admin is blocked', sqlerrm like 'ACCOUNT_GUARD:%');
  end;

  insert into public.app_state (store_key, data) values ('zz-qa-other-key', '{"users":[{"id":"x","email":"x","access":"Super Admin"}]}'::jsonb)
    on conflict (store_key) do update set data = excluded.data;
  update public.app_state set data = '{"users":[]}'::jsonb where store_key = 'zz-qa-other-key';
  perform pg_temp.chk('the guard only watches store_key = larsaStaffV8, not every app_state row', true);

  -- ----------------------------------------------------------
  -- Section 7: account_audit_log
  -- ----------------------------------------------------------
  begin
    perform public.account_audit_log('{"email":"","access":"Super Admin"}'::jsonb, 'zz-qa.test', 'zz-qa-target');
    raise exception 'FAIL: account_audit_log accepted an actor with no email';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('account_audit_log rejects an actor with no valid email', true);
  end;

  perform public.account_audit_log(
    '{"email":"zz-qa-actor@larsaeng.com","access":"Admin"}'::jsonb,
    'zz-qa.audit_check', 'zz-qa-target', 'zz-qa-target-id', 'QA Target', '{"probe":true}'::jsonb);
  select count(*) into n from public.account_lifecycle_audit
    where action = 'zz-qa.audit_check' and target_id = 'zz-qa-target-id' and actor_email = 'zz-qa-actor@larsaeng.com';
  perform pg_temp.chk('account_audit_log writes a correctly-populated row for a valid actor', n = 1);

  raise notice 'ALL VIEWER ACCOUNT TESTS PASSED';
end;
$$;

rollback;
