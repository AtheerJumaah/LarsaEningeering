-- ============================================================
-- Larsa Control — dual-control (maker-checker) tests, migration 007.
--
-- Rules under test:
--   * The accountant plugs in the data; entries land as PENDING
--     APPROVAL no matter what status the form sent (explicit Draft
--     stays a draft). The response flags entered_pending.
--   * Only a DIFFERENT user holding 'approve' moves an entry into a
--     counted status; 'self_approve' is the explicit recorded escape.
--   * Per-AREA approvers (platform settings) and per-PROJECT assigned
--     accountants/approvers narrow who may enter and who may approve.
--     Empty assignment = access (permissions) decides.
--
-- IMPORTANT: this file must NOT call acct_decide_approval or
-- acct_seed_sample_data before its assertions — those set the
-- transaction-local internal flag, which would bypass the rules
-- for the rest of this (single-transaction) test run.
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
  clerk  jsonb := '{"email":"clerk@larsaeng.com","name":"Entry Clerk","role":"Accountant"}'::jsonb;
  clerk2 jsonb := '{"email":"clerk2@larsaeng.com","name":"Second Clerk","role":"Accountant"}'::jsonb;
  boss   jsonb := '{"email":"boss@larsaeng.com","name":"Finance Manager","role":"Management"}'::jsonb;
  finb   jsonb := '{"email":"funding.approver@larsaeng.com","name":"Funding Approver","role":"Management"}'::jsonb;
  owner  jsonb := '{"email":"owner2@larsaeng.com","name":"Owner","role":"Owner / Super Admin"}'::jsonb;
  r jsonb; t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; t6 uuid;
  fee_amt numeric; n int;
begin
  r := public.acct_upsert_project(boss, '{"id":"mc1","name":"Maker Checker Project","currency":"IQD"}'::jsonb);

  -- ----------------------------------------------------------
  -- 1. Entry is never its own approval: requested "approved" lands PENDING
  -- ----------------------------------------------------------
  r := public.acct_post_transaction(clerk, '{"project_id":"mc1","kind":"expense","category":"Site Costs",
        "amount":100000,"currency":"IQD","status":"approved","description":"office supplies"}'::jsonb);
  t1 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('an accountant posting with status "approved" gets PENDING APPROVAL instead',
    (r->'txn'->>'status') = 'pending');
  perform pg_temp.chk('the response says the entry was entered pending',
    coalesce((r->>'entered_pending')::boolean, false));
  perform pg_temp.chk('the requested status is remembered on the entry for the audit trail',
    (r->'txn'->'meta'->>'requested_status') = 'approved'
    and (r->'txn'->'meta'->>'approval_policy') = 'maker_checker');
  perform pg_temp.chk('no approver is stamped on a forced-pending entry',
    (r->'txn'->>'approved_by') is null and (r->'txn'->>'approved_at') is null);
  perform pg_temp.chk('a forced-pending entry is never marked self-approved',
    coalesce((r->'txn'->>'self_approved')::boolean, false) = false);

  r := public.acct_post_transaction(clerk, '{"project_id":"mc1","kind":"expense","category":"Site Costs",
        "amount":9000,"currency":"IQD","status":"draft","description":"still typing this one"}'::jsonb);
  perform pg_temp.chk('an explicit Draft stays a draft (the entry person''s own workspace)',
    (r->'txn'->>'status') = 'draft');

  r := public.acct_post_transaction(clerk, '{"project_id":"mc1","kind":"expense","category":"Site Costs",
        "amount":50000,"currency":"IQD","description":"fuel"}'::jsonb);
  t3 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('posting with no status at all lands as pending approval',
    (r->'txn'->>'status') = 'pending');

  -- Management (holds 'approve' but NOT 'self_approve') gets the same treatment.
  r := public.acct_post_transaction(boss, '{"project_id":"mc1","kind":"funding","amount":1000000,
        "currency":"IQD","status":"received","description":"client first payment"}'::jsonb);
  t2 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('even a manager posting funding as "received" gets PENDING (no self_approve grant)',
    (r->'txn'->>'status') = 'pending');
  perform pg_temp.chk('the client-ready funding receipt is STILL issued immediately while pending',
    (r->'receipt') is not null and (r->'receipt'->>'receipt_no') like 'LRS-RCP-%');
  perform pg_temp.chk('no fee is POSTED while the funding entry awaits approval',
    not exists (select 1 from public.acct_fee_ledger
                 where source_txn_id = t2 and entry_type = 'fee' and status = 'posted'));

  -- ----------------------------------------------------------
  -- 2. The creator cannot approve their own entry
  -- ----------------------------------------------------------
  begin
    r := public.acct_set_txn_status(clerk, t1, 'approved', null);
    raise exception 'FAIL: an accountant without approve permission approved an entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an accountant without the approve permission cannot approve at all',
      sqlerrm like '%do not include%approve%');
  end;

  begin
    r := public.acct_set_txn_status(boss, t2, 'received', null);
    raise exception 'FAIL: the manager approved their own funding entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an approver cannot approve an entry they themselves entered',
      sqlerrm like '%different authorized user%');
  end;

  -- ----------------------------------------------------------
  -- 3. A DIFFERENT authorized user approves — only then it counts
  -- ----------------------------------------------------------
  r := public.acct_set_txn_status(boss, t1, 'approved', 'checked the invoice');
  perform pg_temp.chk('a different user with the approve permission approves the clerk''s entry',
    (r->'txn'->>'status') = 'approved');
  perform pg_temp.chk('the approver of record is the second user, not the creator',
    (r->'txn'->>'approved_by') = 'boss@larsaeng.com'
    and (r->'txn'->>'created_by_email') = 'clerk@larsaeng.com');
  perform pg_temp.chk('a normal second-person approval is not marked self-approved',
    coalesce((r->'txn'->>'self_approved')::boolean, false) = false);

  begin
    r := public.acct_set_txn_status(clerk2, t2, 'received', null);
    raise exception 'FAIL: an accountant without approve permission received funding';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('being a different person is not enough — the approve permission is still required',
      sqlerrm like '%do not include%approve%');
  end;

  r := public.acct_set_txn_status(owner, t2, 'received', null);
  perform pg_temp.chk('the owner (a different user with approve) marks the funding received',
    (r->'txn'->>'status') = 'received' and (r->'txn'->>'approved_by') = 'owner2@larsaeng.com');
  select coalesce(sum(fee_iqd),0) into fee_amt from public.acct_fee_ledger
   where source_txn_id = t2 and entry_type = 'fee' and status = 'posted';
  perform pg_temp.chk('the 8% consultancy fee posts only upon that second-person approval (80,000 IQD)',
    fee_amt = 80000);

  -- ----------------------------------------------------------
  -- 4. Rejection needs the reject permission
  -- ----------------------------------------------------------
  begin
    r := public.acct_set_txn_status(clerk2, t3, 'rejected', 'nope');
    raise exception 'FAIL: an accountant without reject permission rejected an entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('rejecting requires the reject permission',
      sqlerrm like '%do not include%reject%');
  end;
  r := public.acct_set_txn_status(boss, t3, 'rejected', 'duplicate of an earlier fuel invoice');
  perform pg_temp.chk('a manager with the reject permission rejects the pending entry',
    (r->'txn'->>'status') = 'rejected');

  -- ----------------------------------------------------------
  -- 5. Self-approval only through the explicit, recorded permission
  -- ----------------------------------------------------------
  insert into public.platform_admins (email) values ('owner2@larsaeng.com') on conflict do nothing;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner2@larsaeng.com', 'verify', '424242', now() + interval '10 minutes');
  r := public.acct_set_permissions(owner, '424242', 'boss@larsaeng.com',
    '{"self_approve":true}'::jsonb, 'sole finance officer this month');

  r := public.acct_post_transaction(boss, '{"project_id":"mc1","kind":"funding","amount":500000,
        "currency":"IQD","status":"received","description":"client second payment"}'::jsonb);
  t4 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('with the explicit self_approve grant the requested status is honored',
    (r->'txn'->>'status') = 'received' and coalesce((r->>'entered_pending')::boolean,false) = false);
  perform pg_temp.chk('an honored self-approval is permanently marked on the entry',
    (r->'txn'->>'self_approved')::boolean and (r->'txn'->>'approved_by') = 'boss@larsaeng.com');
  select count(*) into n from public.acct_audit
   where record_id = t4::text and details like '%SELF-APPROVED under explicit permission%';
  perform pg_temp.chk('the audit history says the entry was self-approved under explicit permission', n >= 1);

  r := public.acct_post_transaction(clerk, '{"project_id":"mc1","kind":"expense","category":"Site Costs",
        "amount":25000,"currency":"IQD","status":"paid","description":"stationery"}'::jsonb);
  perform pg_temp.chk('the self_approve grant applies only to the user it was given to',
    (r->'txn'->>'status') = 'pending');

  -- ----------------------------------------------------------
  -- 6. Per-AREA approvers (platform): funding assigned to one person
  -- ----------------------------------------------------------
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner2@larsaeng.com', 'verify', '515151', now() + interval '10 minutes');
  r := public.acct_save_platform_settings(owner, '515151',
    '{"area_approvers":{"funding":["Funding.Approver@larsaeng.com "]}}'::jsonb);
  perform pg_temp.chk('area approvers are saved normalized (lowercased, trimmed)',
    (r->'settings'->'area_approvers'->'funding'->>0) = 'funding.approver@larsaeng.com');

  r := public.acct_post_transaction(clerk, '{"project_id":"mc1","kind":"funding","amount":200000,
        "currency":"IQD","description":"client third payment"}'::jsonb);
  t5 := ((r->'txn')->>'id')::uuid;
  begin
    r := public.acct_set_txn_status(boss, t5, 'received', null);
    raise exception 'FAIL: a non-assigned approver approved a funding entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an approver outside the funding area assignment is refused by name',
      sqlerrm like '%funding area is assigned to: funding.approver@larsaeng.com%');
  end;
  r := public.acct_set_txn_status(finb, t5, 'received', null);
  perform pg_temp.chk('the assigned funding approver approves the funding entry',
    (r->'txn'->>'status') = 'received' and (r->'txn'->>'approved_by') = 'funding.approver@larsaeng.com');
  perform pg_temp.chk('expense approvals are untouched by the funding-area assignment (empty = by access)',
    public.acct_approver_scope_ok(boss, 'mc1', 'expense'));

  -- ----------------------------------------------------------
  -- 7. Per-PROJECT assigned accountants and approvers
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(owner, '{"id":"mc2","name":"Assigned Villa","currency":"IQD",
        "assigned_accountants":["clerk@larsaeng.com"],"assigned_approvers":["boss@larsaeng.com"]}'::jsonb);
  perform pg_temp.chk('per-project assignment is stored on the project',
    (r->'project'->'assigned_accountants'->>0) = 'clerk@larsaeng.com'
    and (r->'project'->'assigned_approvers'->>0) = 'boss@larsaeng.com');

  begin
    r := public.acct_post_transaction(clerk2, '{"project_id":"mc2","kind":"expense","category":"Site Costs",
          "amount":10000,"currency":"IQD","description":"unauthorized entry"}'::jsonb);
    raise exception 'FAIL: a non-assigned accountant entered data for an assigned project';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('data entry on an assigned project is limited to the assigned accountant',
      sqlerrm like '%data entry for project%is assigned to: clerk@larsaeng.com%');
  end;

  r := public.acct_post_transaction(clerk, '{"project_id":"mc2","kind":"expense","category":"Site Costs",
        "amount":30000,"currency":"IQD","description":"site expense"}'::jsonb);
  t6 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('the assigned accountant enters data and it waits as pending',
    (r->'txn'->>'status') = 'pending');

  begin
    r := public.acct_set_txn_status(owner, t6, 'approved', null);
    raise exception 'FAIL: a non-assigned approver approved an assigned project''s entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('approval on an assigned project is limited to the assigned approver (even for the owner)',
      sqlerrm like '%approval for project%is assigned to: boss@larsaeng.com%');
  end;
  r := public.acct_set_txn_status(boss, t6, 'approved', 'reviewed on site');
  perform pg_temp.chk('the project''s assigned approver approves the assigned accountant''s entry',
    (r->'txn'->>'status') = 'approved' and (r->'txn'->>'approved_by') = 'boss@larsaeng.com');

  perform pg_temp.chk('the owner can still ENTER data on the assigned project (approval stays with the assignee)',
    (public.acct_post_transaction(owner, '{"project_id":"mc2","kind":"expense","category":"Site Costs",
       "amount":5000,"currency":"IQD","description":"owner-entered"}'::jsonb)->'txn'->>'status') = 'pending');

  -- Review axis honors the same assignment.
  begin
    r := public.acct_review_entry(owner, t6, 'approved', null);
    raise exception 'FAIL: a non-assigned reviewer review-approved an assigned project''s entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('the review workflow honors the project approver assignment too',
      sqlerrm like '%approval for project%is assigned to: boss@larsaeng.com%');
  end;
end $$;

select 'MAKER-CHECKER SQL TESTS COMPLETE' as done;
rollback;
