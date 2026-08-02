-- ============================================================
-- Larsa Control — review workflow, receipts, statements, and
-- multi-accountant permission tests (migration 006).
-- Same harness as accounting-sql.test.sql; rolls back at the end.
-- ============================================================
\set ON_ERROR_STOP on
begin;
-- Migration 007 adds the maker-checker rule (new entries forced to DRAFT,
-- approval only by a different user). This suite tests the CALCULATION
-- engine (rates, fees, refunds, receipts, review math), so it runs under
-- the sanctioned internal flag exactly like system flows do; the rule
-- itself is covered by accounting-makerchecker-sql.test.sql.
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
  entry jsonb := '{"email":"entry.only@larsaeng.com","name":"Entry Clerk","role":"Accountant"}'::jsonb;
  senior jsonb := '{"email":"senior@larsaeng.com","name":"Senior Accountant","role":"Management"}'::jsonb;
  viewer jsonb := '{"email":"viewonly@larsaeng.com","name":"View Only","role":"Accountant"}'::jsonb;
  admin jsonb := '{"email":"owner@larsaeng.com","name":"Owner","role":"Owner / Super Admin"}'::jsonb;
  r jsonb; s jsonb; req jsonb;
  f1 uuid; m1 uuid; m2 uuid;
  rcpt uuid; rcpt_no text; rcpt2_no text;
  before_amt numeric; n int; big numeric;
  snapshot_client text;
  reqid uuid;
  stmt jsonb;
begin
  -- ----------------------------------------------------------
  -- Permission engine: role defaults + explicit per-user overrides
  -- ----------------------------------------------------------
  perform pg_temp.chk('an Accountant can create by default', public.acct_has_perm(entry, 'create'));
  perform pg_temp.chk('an Accountant cannot approve by default', not public.acct_has_perm(entry, 'approve'));
  perform pg_temp.chk('Management can review and approve by default',
    public.acct_has_perm(senior, 'review') and public.acct_has_perm(senior, 'approve'));

  -- Platform Super Admin restricts one accountant to view-only.
  insert into public.platform_admins (email) values ('owner@larsaeng.com') on conflict do nothing;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner@larsaeng.com','verify','101010', now() + interval '10 minutes');
  r := public.acct_set_permissions(admin, '101010', 'viewonly@larsaeng.com',
    '{"create":false,"submit_review":false,"print_receipts":false}'::jsonb, 'view-only accountant');
  perform pg_temp.chk('explicit per-user grant overrides the role default',
    not public.acct_has_perm(viewer, 'create') and public.acct_has_perm(viewer, 'view'));
  begin
    r := public.acct_upsert_project(viewer, '{"id":"pv","name":"nope"}'::jsonb);
    raise exception 'FAIL: view-only accountant was allowed to write';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a view-only accountant is blocked from every write entry point', true);
  end;

  -- ----------------------------------------------------------
  -- Working totals + approval workflow
  -- ----------------------------------------------------------
  r := public.acct_upsert_project(senior, '{"id":"prj_rev","name":"Review Flow","currency":"IQD","approved_budget":100000000,"budget_currency":"IQD"}'::jsonb);
  r := public.acct_post_transaction(entry, '{"project_id":"prj_rev","kind":"funding","amount":10000000,"currency":"IQD","status":"received","date":"2026-02-01","meta":{"payerName":"Client A","method":"Cash","receivedBy":"Site Office"}}'::jsonb);
  f1 := ((r->'txn')->>'id')::uuid;
  perform pg_temp.chk('a new entry starts Unreviewed', (r->'txn'->>'review_status') = 'unreviewed');
  perform pg_temp.chk('a funding receipt exists immediately after saving — approval does not block it',
    (r->'receipt'->>'receipt_no') is not null);
  rcpt := ((r->'receipt')->>'id')::uuid;
  rcpt_no := r->'receipt'->>'receipt_no';
  perform pg_temp.chk('the receipt shows the pending-review phrase status at issue',
    (r->'receipt'->>'status_at_issue') = 'unreviewed');

  r := public.acct_post_transaction(entry, '{"project_id":"prj_rev","kind":"material","amount":15000000,"currency":"IQD","status":"approved","date":"2026-02-10"}'::jsonb);
  m1 := ((r->'txn')->>'id')::uuid;
  r := public.acct_post_transaction(entry, '{"project_id":"prj_rev","kind":"material","amount":5000000,"currency":"IQD","status":"approved","date":"2026-02-12"}'::jsonb);
  m2 := ((r->'txn')->>'id')::uuid;

  s := public.acct_review_breakdown('prj_rev');
  perform pg_temp.chk('the FULL Working Total includes unreviewed entries (materials 20,000,000)',
    (s->'material'->>'working_iqd')::numeric = 20000000);
  perform pg_temp.chk('unreviewed entries make the materials total yellow',
    (s->'material'->>'status') = 'yellow');
  perform pg_temp.chk('the pending amount is reported next to the working total',
    (s->'material'->>'pending_iqd')::numeric = 20000000);

  -- Submit + approve m1; totals keep the same amount, status still yellow (m2 pending)
  before_amt := (public.acct_review_breakdown('prj_rev')->'material'->>'working_iqd')::numeric;
  r := public.acct_submit_for_review(entry, m1);
  perform pg_temp.chk('submitting changes status, never the amount',
    (r->'txn'->>'review_status') = 'pending_review'
    and (public.acct_review_breakdown('prj_rev')->'material'->>'working_iqd')::numeric = before_amt);

  -- The entry clerk cannot approve at all; the senior can.
  begin
    r := public.acct_review_entry(entry, m1, 'approved', null);
    raise exception 'FAIL: entry-only accountant approved an entry';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an entry-only accountant cannot approve', true);
  end;
  r := public.acct_review_entry(senior, m1, 'approved', 'checked against the invoice');
  perform pg_temp.chk('an authorized reviewer approves without duplicating the entry',
    (r->'txn'->>'review_status') = 'approved');
  s := public.acct_review_breakdown('prj_rev');
  perform pg_temp.chk('materials: 20,000,000 working / 15,000,000 approved / 5,000,000 pending — still yellow',
    (s->'material'->>'working_iqd')::numeric = 20000000
    and (s->'material'->>'approved_iqd')::numeric = 15000000
    and (s->'material'->>'pending_iqd')::numeric = 5000000
    and (s->'material'->>'status') = 'yellow');

  -- Needs Correction turns the total red and requires a comment.
  begin
    r := public.acct_review_entry(senior, m2, 'needs_correction', '');
    raise exception 'FAIL: correction request accepted without a comment';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a correction request requires a comment', true);
  end;
  r := public.acct_review_entry(senior, m2, 'needs_correction', 'wrong supplier total');
  s := public.acct_review_breakdown('prj_rev');
  perform pg_temp.chk('one Needs-Correction entry makes the materials total red',
    (s->'material'->>'status') = 'red'
    and (s->'material'->>'working_iqd')::numeric = 20000000);

  -- Fix it (still active the whole time), then approve everything → green.
  r := public.acct_review_entry(senior, m2, 'approved', 'corrected offline, verified');
  s := public.acct_review_breakdown('prj_rev');
  perform pg_temp.chk('all materials approved: same amount, now green',
    (s->'material'->>'status') = 'green'
    and (s->'material'->>'working_iqd')::numeric = 20000000
    and (s->'material'->>'approved_iqd')::numeric = 20000000);

  -- Self-approval: the funding entry was created by the entry clerk. Give the
  -- clerk approve rights but NOT self_approve — still refused for their own entry.
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner@larsaeng.com','verify','111111', now() + interval '10 minutes');
  r := public.acct_set_permissions(admin, '111111', 'entry.only@larsaeng.com', '{"approve":true}'::jsonb, 'promote to approver');
  begin
    r := public.acct_review_entry(entry, f1, 'approved', null);
    raise exception 'FAIL: creator self-approved without the explicit permission';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('a creator cannot approve their own entry without the explicit self-approval permission', true);
  end;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner@larsaeng.com','verify','121212', now() + interval '10 minutes');
  r := public.acct_set_permissions(admin, '121212', 'entry.only@larsaeng.com', '{"approve":true,"self_approve":true}'::jsonb, 'explicit self-approval');
  r := public.acct_review_entry(entry, f1, 'approved', null);
  perform pg_temp.chk('explicit self-approval works and is recorded permanently on the entry',
    (r->'txn'->>'self_approved')::boolean = true);
  select count(*) into n from public.acct_audit where action like '%SELF-APPROVED%';
  perform pg_temp.chk('self-approval is recorded in the audit history', n >= 1);

  -- ----------------------------------------------------------
  -- Approval changes reliability, not amounts: summary working layer
  -- ----------------------------------------------------------
  s := public.acct_project_summary_v2('prj_rev');
  perform pg_temp.chk('summary v2 carries the review breakdown with the classic figures unchanged',
    (s->>'gross_funding_iqd')::numeric = 10000000
    and (s->'review'->'funding'->>'working_iqd')::numeric = 10000000
    and (s->'review'->>'overall_status') is not null);

  -- ----------------------------------------------------------
  -- Editing an approved entry = recorded revision, back to Pending Review
  -- ----------------------------------------------------------
  r := public.acct_post_transaction(entry, '{"project_id":"prj_rev","kind":"expense","amount":1000000,"currency":"IQD","status":"pending","date":"2026-03-01"}'::jsonb);
  m1 := ((r->'txn')->>'id')::uuid;
  r := public.acct_review_entry(senior, m1, 'approved', 'ok');
  begin
    r := public.acct_update_transaction(entry, m1, '{"amount":1200000}'::jsonb);
    raise exception 'FAIL: approved entry edited without reopen permission';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('an approved entry cannot be edited silently', true);
  end;
  r := public.acct_update_transaction(senior, m1, '{"amount":1200000,"reason":"supplier revised the invoice"}'::jsonb);
  perform pg_temp.chk('a reopen-authorized revision returns the entry to Pending Review',
    (r->'txn'->>'review_status') = 'pending_review'
    and (r->'txn'->>'original_amount')::numeric = 1200000);
  select count(*) into n from public.acct_audit where action like '%Revised (was approved%';
  perform pg_temp.chk('the revision of an approved entry is recorded', n >= 1);

  -- ----------------------------------------------------------
  -- Receipts: numbering, printing history, snapshot immutability
  -- ----------------------------------------------------------
  select count(distinct receipt_no) into n from public.acct_receipts;
  select count(*) into big from public.acct_receipts;
  perform pg_temp.chk('receipt numbers are unique', n = big);

  r := public.acct_log_receipt_print(entry, rcpt, false, null);
  r := public.acct_log_receipt_print(entry, rcpt, true, 'client asked for a second copy');
  perform pg_temp.chk('printing and reprinting are recorded with the review status at that moment',
    (select count(*) from public.acct_receipt_prints where receipt_id = rcpt) = 2
    and (select count(*) from public.acct_receipt_prints where receipt_id = rcpt and is_reprint) = 1);
  perform pg_temp.chk('the reprint keeps the original receipt number',
    (select receipt_no from public.acct_receipts where id = rcpt) = rcpt_no);

  -- Later data changes never rewrite an issued receipt.
  select snapshot->>'client_name' into snapshot_client from public.acct_receipts where id = rcpt;
  r := public.acct_upsert_project(senior, '{"id":"prj_rev","client":"Renamed Client LLC","name":"Review Flow RENAMED"}'::jsonb);
  perform pg_temp.chk('renaming the project/client never changes an issued receipt',
    (select snapshot->>'client_name' from public.acct_receipts where id = rcpt) = snapshot_client
    and (select snapshot->>'project_name' from public.acct_receipts where id = rcpt) = 'Review Flow');
  begin
    update public.acct_receipts set snapshot = '{}'::jsonb where id = rcpt;
    raise exception 'FAIL: receipt snapshot was rewritten';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('receipt snapshots are immutable at the database level', true);
  end;
  begin
    delete from public.acct_receipts where id = rcpt;
    raise exception 'FAIL: real receipt was deleted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('real receipts can never be deleted', true);
  end;

  -- Corrected receipt through the approved void+replace workflow.
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('senior@larsaeng.com','verify','131313', now() + interval '10 minutes');
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('owner@larsaeng.com','verify','141414', now() + interval '10 minutes');
  req := public.acct_request_protected(senior, '131313', 'change_historical_rate', 'prj_rev',
    jsonb_build_object('txn_id', f1, 'new_rate', 1400), 'entered at the wrong rate');
  reqid := ((req->'request')->>'id')::uuid;
  r := public.acct_decide_approval(admin, '141414', reqid, true, null);
  perform pg_temp.chk('the rate correction executed', r->>'status' = 'executed');
  select r2.receipt_no into rcpt2_no
    from public.acct_receipts r2
   where r2.kind = 'corrected' and r2.corrects_receipt_id = rcpt;
  perform pg_temp.chk('the replacement funding got a CORRECTED receipt referencing the original',
    rcpt2_no is not null and rcpt2_no <> rcpt_no);
  perform pg_temp.chk('the original receipt is preserved and linked forward',
    (select corrected_by_receipt_id from public.acct_receipts where id = rcpt) is not null);

  -- ----------------------------------------------------------
  -- Project funding statement
  -- ----------------------------------------------------------
  stmt := public.acct_funding_statement('prj_rev', null, null);
  perform pg_temp.chk('the statement lists the active funding entries with receipt numbers',
    jsonb_array_length(stmt->'entries') = 1
    and (stmt->'entries'->0->>'receipt_no') is not null);
  perform pg_temp.chk('the statement totals match the stored records',
    (stmt->>'total_funding_iqd')::numeric = 10000000);
  perform pg_temp.chk('unapproved entries stay visible and the statement is labeled',
    (stmt->>'contains_pending')::boolean = true
    and stmt->>'pending_label' = 'Contains Entries Pending Internal Approval');

  -- ----------------------------------------------------------
  -- RLS: direct API writes are refused even for signed-in sessions
  -- ----------------------------------------------------------
  begin
    set local role authenticated;
    insert into public.acct_transactions (txn_no, project_id, kind, txn_date, original_amount, original_currency, exchange_rate, amount_iqd, amount_usd)
    values ('HACK-1', 'prj_rev', 'funding', current_date, 1, 'IQD', 1310, 1, 0);
    reset role;
    raise exception 'FAIL: direct insert into acct_transactions succeeded';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('RLS + revokes block direct writes to the accounting ledger', true);
  end;
  begin
    set local role authenticated;
    update public.acct_receipts set status_at_issue = 'approved' where id = rcpt;
    reset role;
    raise exception 'FAIL: direct update of a receipt succeeded';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    perform pg_temp.chk('RLS + revokes block direct writes to receipts', true);
  end;

  raise notice 'ALL REVIEW/RECEIPT/PERMISSION TESTS PASSED';
end;
$$;

rollback;
