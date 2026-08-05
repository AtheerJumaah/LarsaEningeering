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
  -- The viewer_accounts row ids, needed because section grants key off the
  -- account rather than the auth user.
  viewer_a_id uuid;
  viewer_all_id uuid;
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

  select id into viewer_a_id   from public.viewer_accounts where username = 'zz-qa-viewer-a';
  select id into viewer_all_id from public.viewer_accounts where username = 'zz-qa-viewer-all';

  -- ----------------------------------------------------------
  -- Section 3: RLS, exercised as the roles that actually hit these
  -- tables — a Viewer's own session, and an ordinary employee session.
  -- ----------------------------------------------------------
  -- Assignment alone now shows a client nothing: every section starts OFF and
  -- every record starts Internal Only. Proving that BEFORE granting anything
  -- is the point — it is the state a newly created Viewer is actually in.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);

  select count(*) into n from public.acct_projects;
  perform pg_temp.chk('an assigned project with no sections switched on is invisible', n = 0);
  select count(*) into n from public.acct_progress_updates;
  perform pg_temp.chk('and so are its progress updates', n = 0);

  -- Now switch on exactly what this client may see, as an admin would.
  reset role;
  insert into public.viewer_project_sections (viewer_id, project_id, section, enabled)
  values (viewer_a_id, 'zz-qa-viewer-prj-a', 'overview', true),
         (viewer_a_id, 'zz-qa-viewer-prj-a', 'updates',  true);
  -- One of the two notes is published to the client; the other stays internal.
  update public.acct_progress_updates set client_visible = true
   where project_id = 'zz-qa-viewer-prj-a' and note = 'QA progress note A';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);

  select count(*) into n from public.acct_projects; perform pg_temp.chk('a scoped Viewer sees exactly one project through RLS, not both', n = 1);
  select count(*) into n from public.acct_projects where id = 'zz-qa-viewer-prj-a'; perform pg_temp.chk('...and it is the assigned one', n = 1);
  select count(*) into n from public.acct_transactions; perform pg_temp.chk('a Viewer reads zero transactions — the ledger is closed to clients outright', n = 0);
  select count(*) into n from public.acct_progress_updates; perform pg_temp.chk('only the client-visible update is returned, not the internal one', n = 1);
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
  select count(*) into n from public.acct_projects;
  perform pg_temp.chk('mode=all still shows nothing until sections are granted', n = 0);
  reset role;
  insert into public.viewer_project_sections (viewer_id, project_id, section, enabled)
  select viewer_all_id, p.id, 'overview', true from public.acct_projects p;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_all_uid::text, true);
  select count(*) into n from public.acct_projects; perform pg_temp.chk('a mode=all Viewer with overview on sees both projects', n = 2);

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
  -- Section 3b: viewer_accounts is itself readable under RLS.
  -- Regression test for the infinite-recursion policy fixed in audit_023.
  -- The read policy used to ask "is the caller a viewer?" with an INLINE
  -- subquery against viewer_accounts, so any direct SELECT on the table
  -- re-entered the policy forever — Postgres 42P17 "infinite recursion
  -- detected in policy for relation viewer_accounts". Every check above
  -- reads viewer_accounts only INDIRECTLY, through the SECURITY DEFINER
  -- is_any_viewer() (which bypasses RLS), so none of them ever tripped it.
  -- The admin "Users & Access -> Viewer Accounts" panel loads the table
  -- with a direct `from("viewer_accounts").select("*")`, which is exactly
  -- the read that recursed — the panel was dead in production until the fix.
  -- These two checks fail with 42P17 against the old policy and pass now.
  set local role authenticated;
  -- A non-viewer employee session (auth.uid() matches no viewer row) must
  -- list the whole directory for the admin UI — and must not recurse.
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from public.viewer_accounts;
  perform pg_temp.chk('a non-viewer session lists every viewer account without recursion (the admin directory read)', n = 6);

  -- A viewer session sees only its own row, never another client's — the
  -- isolation half of the same policy, preserved exactly by the fix.
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);
  select count(*) into n from public.viewer_accounts;
  perform pg_temp.chk('a viewer session reads exactly one viewer_accounts row (its own), not the whole directory', n = 1);
  select count(*) into n from public.viewer_accounts where auth_user_id <> viewer_a_uid;
  perform pg_temp.chk('a viewer session can never see another client''s viewer_accounts row', n = 0);
  perform set_config('request.jwt.claim.sub', '', true);
  reset role;

  -- Grants that back the read policy: authenticated may read the directory,
  -- anon (no session, public key only) may not — so removing the recursion
  -- does not hand the client list to an unauthenticated caller.
  select has_table_privilege('authenticated', 'public.viewer_accounts', 'select') into ok;
  perform pg_temp.chk('authenticated holds SELECT on viewer_accounts (the admin directory read reaches RLS)', ok = true);
  select has_table_privilege('anon', 'public.viewer_accounts', 'select') into ok;
  perform pg_temp.chk('anon has NO SELECT on viewer_accounts (fixing the recursion does not expose the client list)', ok = false);

  -- ----------------------------------------------------------
  -- Section 4: viewer_project_summary — the one RPC a Viewer needs that
  -- table-level RLS alone cannot police (it wraps acct_project_summary,
  -- which trusts any caller for any project id).
  -- ----------------------------------------------------------
  -- The financial summary is a section like any other, so it is off until
  -- granted. That is checked first, then granted, then checked again.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);
  perform pg_temp.chk('the financial summary is refused until its section is switched on',
    public.viewer_project_summary('zz-qa-viewer-prj-a') is null);

  reset role;
  insert into public.viewer_project_sections (viewer_id, project_id, section, enabled)
  values (viewer_a_id, 'zz-qa-viewer-prj-a', 'financials', true)
  on conflict (viewer_id, project_id, section) do update set enabled = true;

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
  -- Section 4b: the gap Section 4's own comment named but never tested —
  -- "acct_project_summary... trusts any caller for any project id". A
  -- Viewer calling it directly, instead of through viewer_project_summary
  -- (which strips Larsa's own figures before returning), used to get the
  -- unstripped object back: gross funding, consultancy fees, company
  -- profit, for any project by id, or company-wide. Audit fix
  -- (20260804_audit_022_viewer_rpc_isolation): all five below now refuse a
  -- genuine Viewer identity; the legitimate viewer_project_summary path,
  -- just proven working above, has to keep working too, because it now
  -- marks its own call as an authorized internal one before reaching them.
  --
  -- acct.internal_op was set for the whole file at the top of this
  -- transaction (line 9), which would silently defeat every assertion
  -- below (the new check is a no-op whenever it is set). Cleared here to
  -- match what a real RPC call actually sees — PostgREST gives each one
  -- its own fresh transaction — and restored after, so section 6 and 7
  -- get back the ambient state they were written against.
  -- ----------------------------------------------------------
  perform set_config('acct.internal_op', '', true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);

  begin
    perform public.acct_project_summary('zz-qa-viewer-prj-a');
    raise exception 'FAIL: a Viewer called acct_project_summary directly and it did not refuse';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a Viewer calling acct_project_summary directly is refused, even for its own assigned project', sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  begin
    perform public.acct_project_financials('zz-qa-viewer-prj-a');
    raise exception 'FAIL: a Viewer called acct_project_financials directly and it did not refuse';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('...and acct_project_financials refuses it too, not just the summary wrapper', sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  begin
    perform public.acct_company_financials(null, null);
    raise exception 'FAIL: a Viewer called acct_company_financials directly and it did not refuse';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('...and company-wide financials refuse a Viewer too, not just a single project', sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  begin
    perform public.acct_funding_statement('zz-qa-viewer-prj-a', null, null);
    raise exception 'FAIL: a Viewer called acct_funding_statement directly and it did not refuse';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('...and the funding statement, which does not route through acct_project_financials at all', sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  begin
    perform public.acct_compute_refund('zz-qa-viewer-prj-a', null, null);
    raise exception 'FAIL: a Viewer called acct_compute_refund directly and it did not refuse';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('...and the refund calculator, independently reachable on its own', sqlerrm like 'ACCT_FORBIDDEN:%');
  end;
  reset role;

  -- The other side of the same guarantee: an ordinary employee session —
  -- authenticated, but auth.uid() matches no viewer_accounts row, exactly
  -- like every real employee session today (Section 3 already proved this
  -- identity reads every project through RLS unfiltered) — must see zero
  -- change from this fix.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  r := public.acct_project_summary('zz-qa-viewer-prj-a');
  perform pg_temp.chk('an ordinary employee session still gets the full summary directly, unblocked',
    r is not null and r->>'project_id' = 'zz-qa-viewer-prj-a');
  select string_agg(k, ',') into keys from jsonb_object_keys(r) k;
  perform pg_temp.chk('...including the Larsa-only figures a Viewer must never see — the block is Viewer-specific, not a general lockdown',
    position('larsa_revenue' in keys) > 0);
  r := public.acct_company_financials(null, null);
  perform pg_temp.chk('an ordinary employee session still gets company-wide financials directly', r is not null and (r->>'projects')::int >= 2);
  reset role;

  -- And the legitimate path survives the fix: the same call Section 4
  -- already proved returns data now has to route through the newly-added
  -- internal-call marker to reach the same, now-guarded functions.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', viewer_a_uid::text, true);
  r := public.viewer_project_summary('zz-qa-viewer-prj-a');
  perform pg_temp.chk('viewer_project_summary itself still returns data after the fix — the internal-op marker actually bridges the block',
    r is not null and r->>'project_id' = 'zz-qa-viewer-prj-a');
  reset role;

  perform set_config('acct.internal_op', '1', true);

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
