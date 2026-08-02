-- ============================================================
-- Larsa Control — Accounting engine SQL tests.
-- Runs against a database with the acct_* migrations applied
-- (see tests/run-sql-tests.sh, which spins up a local PostgreSQL
-- with shims for auth.role(), platform_admins, auth_codes).
-- Every check RAISES on failure; a clean run prints only PASS lines.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.chk(label text, ok boolean)
returns void language plpgsql as $$
begin
  if ok is distinct from true then
    raise exception 'FAIL: %', label;
  end if;
  raise notice 'PASS: %', label;
end;
$$;

do $$
declare
  actor jsonb := '{"email":"test.accountant@larsaeng.com","name":"Test Accountant","role":"Accountant"}'::jsonb;
  viewer jsonb := '{"email":"test.viewer@larsaeng.com","name":"Test Viewer","role":"Viewer"}'::jsonb;
  admin jsonb := '{"email":"test.owner@larsaeng.com","name":"Test Owner","role":"Owner / Super Admin"}'::jsonb;
  r jsonb; s jsonb; f jsonb; calc jsonb; req jsonb;
  t1 uuid; t2 uuid; exp1 uuid;
  fee1 numeric; fee2 numeric;
  n int; big numeric;
  reqid uuid;
  errtext text;
begin
  -- ----------------------------------------------------------
  -- Sample data appears only for an empty organization
  -- ----------------------------------------------------------
  r := public.acct_seed_sample_data(actor);
  perform pg_temp.chk('sample data seeds for an empty organization', (r->>'ok')::boolean);
  select count(*) into n from public.acct_projects where is_sample;
  perform pg_temp.chk('sample projects exist and are marked internally', n >= 3);
  r := public.acct_seed_sample_data(actor);
  perform pg_temp.chk('sample data does not seed twice', (r->>'ok')::boolean = false);

  -- The 1500/1600 historical FX example lives in the sample data itself:
  select sum(amount_iqd) into big from public.acct_transactions
   where project_id = 'prj_sample_alnoor' and kind = 'funding';
  perform pg_temp.chk('USD 1,000 @1500 + USD 1,000 @1600 = IQD 3,100,000 historically', big = 3100000);

  -- ----------------------------------------------------------
  -- Platform default fee is 8% percentage / funding / deducted
  -- ----------------------------------------------------------
  perform pg_temp.chk('platform default consultancy fee is 8%',
    (select default_fee_rate = 0.08 and default_fee_method = 'percentage' from public.acct_platform_settings where id = 1));

  -- ----------------------------------------------------------
  -- Real project: hierarchy, snapshots, incremental fees
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","name":"Hierarchy Test","currency":"IQD","approved_budget":100000000,"budget_currency":"IQD","contract_value":150000000}'::jsonb);
  perform pg_temp.chk('project created', (r->>'ok')::boolean);

  -- Rate hierarchy: no project default → platform default
  r := public.acct_resolve_rate('prj_test1', null);
  perform pg_temp.chk('rate inherits platform default', r->>'source' = 'platform_default');
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","default_exchange_rate":1450}'::jsonb);
  r := public.acct_resolve_rate('prj_test1', null);
  perform pg_temp.chk('rate uses project default when set', r->>'source' = 'project_default' and (r->>'rate')::numeric = 1450);
  r := public.acct_resolve_rate('prj_test1', 1520);
  perform pg_temp.chk('transaction override wins the rate hierarchy', r->>'source' = 'transaction_override' and (r->>'rate')::numeric = 1520);

  -- Fee hierarchy: platform → project → category → transaction
  r := public.acct_resolve_fee_rule('prj_test1', 'funding', null, null);
  perform pg_temp.chk('fee rule inherits platform 8% default', r->>'source' = 'platform_default' and (r->>'rate')::numeric = 0.08);
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","fee_inherit":false,"fee_method":"percentage","fee_rate":0.05,"fee_basis":"funding","fee_treatment":"deduct_from_funding","fee_category_overrides":[{"category":"Special","method":"percentage","rate":0.02}]}'::jsonb);
  r := public.acct_resolve_fee_rule('prj_test1', 'funding', null, null);
  perform pg_temp.chk('fee rule uses project default when defined', r->>'source' = 'project_default' and (r->>'rate')::numeric = 0.05);
  r := public.acct_resolve_fee_rule('prj_test1', 'funding', 'Special', null);
  perform pg_temp.chk('category override beats project default', r->>'source' = 'category_override' and (r->>'rate')::numeric = 0.02);
  r := public.acct_resolve_fee_rule('prj_test1', 'funding', 'Special', '{"method":"percentage","rate":0.10}'::jsonb);
  perform pg_temp.chk('transaction override beats category override', r->>'source' = 'transaction_override' and (r->>'rate')::numeric = 0.10);

  -- Viewer cannot post
  begin
    r := public.acct_post_transaction(viewer, '{"project_id":"prj_test1","kind":"funding","amount":1000,"currency":"IQD"}'::jsonb);
    raise exception 'FAIL: viewer was allowed to post a transaction';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('viewer role is refused by the backend', true);
  end;

  -- ----------------------------------------------------------
  -- The required incremental-fee example (§11):
  -- 10,000,000 @8% → 800,000; +2,000,000 → +160,000; total 960,000.
  -- (Project set back to 8% first.)
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","fee_rate":0.08,"fee_category_overrides":[]}'::jsonb);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_test1","kind":"funding","amount":10000000,"currency":"IQD","status":"received","date":"2026-01-10","description":"First funding"}'::jsonb);
  t1 := ((r->'txn')->>'id')::uuid;
  fee1 := ((r->'fee')->>'fee_amount')::numeric;
  perform pg_temp.chk('first funding fee is 800,000', fee1 = 800000);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_test1","kind":"funding","amount":2000000,"currency":"IQD","status":"received","date":"2026-02-10","description":"Additional funding"}'::jsonb);
  t2 := ((r->'txn')->>'id')::uuid;
  fee2 := ((r->'fee')->>'fee_amount')::numeric;
  perform pg_temp.chk('additional funding generates ONLY its additional fee (160,000)', fee2 = 160000);
  select sum(fee_amount) into big from public.acct_fee_ledger
   where project_id = 'prj_test1' and entry_type = 'fee' and status in ('posted','settled');
  perform pg_temp.chk('total initial fee is 960,000 — 8% never re-applied to the whole 12,000,000', big = 960000);

  -- One transaction can never generate the same fee twice
  r := public.acct_sync_fee_for_txn(actor, t1);
  select count(*) into n from public.acct_fee_ledger
   where source_txn_id = t1 and entry_type = 'fee' and status in ('estimated','posted','settled');
  perform pg_temp.chk('re-syncing a transaction cannot create a second fee', n = 1);

  -- Changing project/platform defaults later never touches history
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","fee_rate":0.12,"default_exchange_rate":1999}'::jsonb);
  select fee_amount into big from public.acct_fee_ledger where source_txn_id = t1 and entry_type = 'fee';
  perform pg_temp.chk('changing the project fee default does not recalculate the posted 800,000', big = 800000);
  select exchange_rate into big from public.acct_transactions where id = t1;
  perform pg_temp.chk('changing the project rate default does not rewrite the stored rate snapshot', big = 1450);
  r := public.acct_upsert_project(actor, '{"id":"prj_test1","fee_rate":0.08}'::jsonb);

  -- ----------------------------------------------------------
  -- The required refund example (§12):
  -- Gross 10,000,000 / 8% → refund 2,376,000, retained 624,000.
  -- Built on its own project to match the example exactly.
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(actor, '{"id":"prj_refund","name":"Refund Example","currency":"IQD","fee_inherit":true}'::jsonb);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_refund","kind":"funding","amount":10000000,"currency":"IQD","status":"received","date":"2026-01-05"}'::jsonb);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_refund","kind":"expense","amount":7000000,"currency":"IQD","status":"approved","date":"2026-03-01","category":"Construction"}'::jsonb);
  exp1 := ((r->'txn')->>'id')::uuid;
  calc := public.acct_compute_refund('prj_refund', null, null);
  perform pg_temp.chk('unused net funding is 2,200,000',        (calc->>'unused_net_funding_iqd')::numeric = 2200000);
  perform pg_temp.chk('refundable consultancy fee is 176,000',  (calc->>'refundable_fee_iqd')::numeric = 176000);
  perform pg_temp.chk('total client refund is 2,376,000',       (calc->>'total_refund_iqd')::numeric = 2376000);
  perform pg_temp.chk('final fee retained by Larsa is 624,000', (calc->>'retained_fee_iqd')::numeric = 624000);

  -- Partial refund reverses only the relevant fee
  calc := public.acct_compute_refund('prj_refund', 1000000, null);
  perform pg_temp.chk('partial refund: refundable fee only on the returned 1,000,000 (=80,000)',
    (calc->>'refundable_fee_iqd')::numeric = 80000 and (calc->>'total_refund_iqd')::numeric = 1080000);

  -- ----------------------------------------------------------
  -- Protected workflow: request (fresh code) → platform admin
  -- approval (own code, never self) → executed refund
  -- ----------------------------------------------------------
  insert into public.platform_admins (email) values ('test.owner@larsaeng.com') on conflict do nothing;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('test.accountant@larsaeng.com','verify','111111', now() + interval '10 minutes');
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('test.owner@larsaeng.com','verify','222222', now() + interval '10 minutes');

  s := public.acct_create_refund_settlement(actor, 'prj_refund', null, null, null, 'Client requested unused funds back');
  perform pg_temp.chk('refund settlement drafted with the required rule',
    ((s->'settlement')->>'total_refund')::numeric = 2376000);

  -- Wrong code is refused
  begin
    req := public.acct_request_protected(actor, '999999', 'post_refund', 'prj_refund',
      jsonb_build_object('settlement_id', (s->'settlement')->>'id'), 'refund the client');
    raise exception 'FAIL: wrong email code accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a wrong verification code is refused', true);
  end;

  req := public.acct_request_protected(actor, '111111', 'post_refund', 'prj_refund',
    jsonb_build_object('settlement_id', (s->'settlement')->>'id'), 'refund the client');
  reqid := ((req->'request')->>'id')::uuid;
  perform pg_temp.chk('protected request records the financial impact',
    ((req->'request')->'impact'->>'total_refund_iqd')::numeric = 2376000);

  -- Self-approval refused (requester's own email, even if platform admin)
  insert into public.platform_admins (email) values ('test.accountant@larsaeng.com') on conflict do nothing;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('test.accountant@larsaeng.com','verify','333333', now() + interval '10 minutes');
  begin
    r := public.acct_decide_approval(actor, '333333', reqid, true, null);
    raise exception 'FAIL: self-approval was permitted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('self-approval is refused', true);
  end;
  delete from public.platform_admins where email = 'test.accountant@larsaeng.com';

  -- Non-admin approver refused
  begin
    r := public.acct_decide_approval(viewer, '222222', reqid, true, null);
    raise exception 'FAIL: non-platform-admin approval permitted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('only a Platform Super Admin may approve', true);
  end;

  r := public.acct_decide_approval(admin, '222222', reqid, true, 'Approved for release');
  perform pg_temp.chk('approved refund executes', r->>'status' = 'executed');
  select count(*) into n from public.acct_transactions where project_id = 'prj_refund' and kind = 'refund' and status = 'posted';
  perform pg_temp.chk('refund transaction posted', n = 1);
  select count(*) into n from public.acct_fee_ledger
   where project_id = 'prj_refund' and entry_type = 'fee_reversal';
  perform pg_temp.chk('fee reversal entry created — original fee kept, never overwritten', n = 1);
  select count(*) into n from public.acct_fee_ledger
   where project_id = 'prj_refund' and entry_type = 'fee' and fee_amount = 800000;
  perform pg_temp.chk('original 800,000 fee entry still present', n = 1);

  -- Summary after refund: retained fee reflected
  calc := public.acct_project_summary('prj_refund');
  perform pg_temp.chk('summary separates funding / cost / fee / refund',
    (calc->>'gross_funding_iqd')::numeric = 10000000
    and (calc->>'actual_construction_cost_iqd')::numeric = 7000000
    and (calc->>'initial_fee_iqd')::numeric = 800000
    and (calc->>'fee_reversed_iqd')::numeric = 176000
    and (calc->>'refunded_principal_iqd')::numeric = 2200000
    and (calc->>'remaining_unused_iqd')::numeric = 0);

  -- ----------------------------------------------------------
  -- Materials-only basis + expense-based posting rules
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(actor, '{"id":"prj_mat","name":"Materials Basis","currency":"IQD","fee_inherit":false,"fee_method":"percentage","fee_rate":0.04,"fee_basis":"materials_only","fee_treatment":"larsa_revenue"}'::jsonb);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_mat","kind":"material","amount":5000000,"currency":"IQD","status":"pending","date":"2026-04-01"}'::jsonb);
  t1 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('pending expense-based fee is only estimated', (r->'fee'->>'status') = 'estimated');
  r := public.acct_set_txn_status(actor, t1, 'approved', null);
  select fee_amount into big from public.acct_fee_ledger where source_txn_id = t1 and entry_type='fee' and status='posted';
  perform pg_temp.chk('materials-only 4% fee posts on approval (200,000)', big = 200000);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_mat","kind":"labor","amount":3000000,"currency":"IQD","status":"approved","date":"2026-04-02"}'::jsonb);
  perform pg_temp.chk('labor generates NO fee under materials-only basis', (r->'fee') is null or (r->'fee') = 'null'::jsonb);

  -- Rejected expense never posts a fee
  r := public.acct_post_transaction(actor, '{"project_id":"prj_mat","kind":"material","amount":900000,"currency":"IQD","status":"pending","date":"2026-04-03"}'::jsonb);
  t2 := ((r->'txn')->>'id')::uuid;
  r := public.acct_set_txn_status(actor, t2, 'rejected', 'not needed');
  select count(*) into n from public.acct_fee_ledger where source_txn_id = t2 and status in ('posted','settled');
  perform pg_temp.chk('rejected expenses generate no posted fee', n = 0);

  -- ----------------------------------------------------------
  -- Immutability + soft delete + append-only audit
  -- ----------------------------------------------------------
  begin
    r := public.acct_update_transaction(actor, t1, '{"amount":123}'::jsonb);
    raise exception 'FAIL: posted transaction was editable';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('posted transactions are immutable (reversal/replacement only)', true);
  end;
  begin
    r := public.acct_soft_delete(actor, t1, 'cleanup');
    raise exception 'FAIL: posted transaction was deletable';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('posted transactions cannot be deleted, even softly', true);
  end;
  begin
    update public.acct_audit set action = 'tampered' where id = (select max(id) from public.acct_audit);
    raise exception 'FAIL: audit row was updatable';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('audit history cannot be edited', true);
  end;
  begin
    delete from public.acct_audit where id = (select max(id) from public.acct_audit);
    raise exception 'FAIL: audit row was deletable';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('audit history cannot be deleted', true);
  end;

  -- ----------------------------------------------------------
  -- Removing sample data removes ONLY sample records
  -- ----------------------------------------------------------
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('test.accountant@larsaeng.com','verify','444444', now() + interval '10 minutes');
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('test.owner@larsaeng.com','verify','555555', now() + interval '10 minutes');
  req := public.acct_request_protected(actor, '444444', 'remove_sample_data', null, '{}'::jsonb, 'Done exploring the samples');
  reqid := ((req->'request')->>'id')::uuid;
  select count(*) into n from public.acct_transactions where not is_sample;
  big := n;
  r := public.acct_decide_approval(admin, '555555', reqid, true, null);
  perform pg_temp.chk('sample removal executes through the protected workflow', r->>'status' = 'executed');
  select count(*) into n from public.acct_transactions where is_sample;
  perform pg_temp.chk('all sample transactions removed', n = 0);
  select count(*) into n from public.acct_projects where is_sample;
  perform pg_temp.chk('all sample projects removed', n = 0);
  select count(*) into n from public.acct_transactions where not is_sample;
  perform pg_temp.chk('removing sample data never touches real records', n = big);
  r := public.acct_seed_sample_data(actor);
  perform pg_temp.chk('sample data is never seeded again after removal', (r->>'ok')::boolean = false and r->>'skipped' = 'removed');

  -- ----------------------------------------------------------
  -- Progress history is preserved
  -- ----------------------------------------------------------
  r := public.acct_record_progress(actor, 'prj_test1', 40, '2026-05-01'::date, 'Structure done');
  r := public.acct_record_progress(actor, 'prj_test1', 55, '2026-06-01'::date, 'Walls done');
  select count(*) into n from public.acct_progress_updates where project_id = 'prj_test1';
  perform pg_temp.chk('every progress update is preserved in history', n = 2);
  calc := public.acct_project_summary('prj_test1');
  perform pg_temp.chk('summary reports schedule progress from the latest update', (calc->>'schedule_progress_pct')::numeric = 55);
  perform pg_temp.chk('funding is never counted as construction cost', (calc->>'actual_construction_cost_iqd')::numeric = 0);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_test1","kind":"material","amount":45000000,"currency":"IQD","status":"approved","date":"2026-06-15","category":"Structure"}'::jsonb);
  calc := public.acct_project_summary('prj_test1');
  perform pg_temp.chk('cost progress = 45% — IQD 45,000,000 of IQD 100,000,000 approved budget',
    (calc->>'cost_progress_pct')::numeric = 45.0);
  r := public.acct_upsert_project(actor, '{"id":"prj_nobudget","name":"No Budget","currency":"IQD"}'::jsonb);
  r := public.acct_post_transaction(actor, '{"project_id":"prj_nobudget","kind":"expense","amount":1000,"currency":"IQD","status":"approved"}'::jsonb);
  calc := public.acct_project_summary('prj_nobudget');
  perform pg_temp.chk('cost progress is Not Available without an approved budget', calc->'cost_progress_pct' = 'null'::jsonb);

  -- Legacy import: preserves records, flags ambiguous ones, never re-imports
  r := public.acct_import_legacy(actor, jsonb_build_object(
    'settings', jsonb_build_object('rate', 1310),
    'projects', jsonb_build_array(jsonb_build_object('id','prj_leg1','name','Legacy P','currency','IQD','consultancyRate',0.03)),
    'funding', jsonb_build_array(jsonb_build_object('id','lf1','projectId','prj_leg1','amount',4000000,'currency','IQD','status','Received','date','2025-06-01','consultancyRate',0.03,'consultancyFee',120000)),
    'materials', jsonb_build_array(jsonb_build_object('id','lm1','projectId','prj_leg1','amount',1000000,'currency','IQD','status','Approved','date','2025-07-01')),
    'expenses', jsonb_build_array(
      jsonb_build_object('id','le1','projectId','prj_leg1','amount',1000000,'currency','IQD','status','Approved','date','2025-07-01'),
      jsonb_build_object('id','le2','projectId','prj_leg1','amount',250000,'currency','IQD','status','Approved','date','2025-08-01'))));
  perform pg_temp.chk('legacy import imports and flags the double-count suspect',
    (r->>'imported')::int = 4 and (r->>'review')::int = 1);
  select fee_amount into big from public.acct_fee_ledger fl join public.acct_transactions t on t.id = fl.source_txn_id
   where t.legacy_id = 'lf1';
  perform pg_temp.chk('legacy fee preserved at its historical 3% — not recalculated to 8%', big = 120000);
  select rate_source into errtext from public.acct_transactions where legacy_id = 'lf1';
  perform pg_temp.chk('legacy records carry the Legacy Migrated Rate marker', errtext = 'legacy_migrated');
  r := public.acct_import_legacy(actor, jsonb_build_object(
    'settings', jsonb_build_object('rate', 1310),
    'funding', jsonb_build_array(jsonb_build_object('id','lf1','projectId','prj_leg1','amount',4000000,'currency','IQD','status','Received'))));
  perform pg_temp.chk('legacy import is idempotent', (r->>'skipped')::int = 1 and (r->>'imported')::int = 0);

  raise notice 'ALL ACCOUNTING SQL TESTS PASSED';
end;
$$;

rollback;
