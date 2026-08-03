-- ============================================================
-- Larsa Functional QA — the specification's controlled numbers, proven
-- against the REAL server functions in a throwaway local cluster.
--
-- Fixture: everything is zz-qa-* / @larsaeng.test and lives only inside
-- this transaction on a scratch database. Nothing here can touch
-- production data.
--
--   payroll: base 2,000,000 + commission 500,000 + allowance 200,000
--            − deduction 100,000 → gross 2,700,000 · net 2,600,000
--            — identical in the admin view, the statement, and the payslip
--   paid runs are immutable; a reversal is a new row and the original stays
--   My Pay privacy: employee A cannot read employee B through the parameter
--   duplicate invoice reference: hard-rejected
--   per-entry fee waiver requires a reason (migration 015)
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
  qaboss  jsonb := '{"email":"zz-qa-boss@larsaeng.test","name":"QA Boss","role":"Owner / Super Admin"}'::jsonb;
  qaclerk jsonb := '{"email":"zz-qa-clerk@larsaeng.test","name":"QA Clerk","role":"Payroll Accountant"}'::jsonb;
  qaemp   jsonb := '{"email":"zz-qa-one@larsaeng.test","name":"QA Employee One","role":"Engineer"}'::jsonb;
  qatwo   jsonb := '{"email":"zz-qa-two@larsaeng.test","name":"QA Employee Two","role":"Engineer"}'::jsonb;
  r jsonb; s jsonb; slip jsonb; ov jsonb;
  pid uuid; payid uuid;
  n int;
begin
  -- ---------- the employees ----------
  perform public.pay_upsert_employee(qaboss, jsonb_build_object(
    'email','zz-qa-one@larsaeng.test','full_name','QA Employee One','employee_no','ZZQA-1',
    'position','QA Engineer','department','QA Fixture','employment_start','2026-01-01',
    'base_salary',2000000,'salary_currency','IQD'));
  perform public.pay_upsert_employee(qaboss, jsonb_build_object(
    'email','zz-qa-two@larsaeng.test','full_name','QA Employee Two','employee_no','ZZQA-2',
    'position','QA Engineer','department','QA Fixture','employment_start','2026-01-01',
    'base_salary',1000000,'salary_currency','IQD'));

  -- ---------- the spec's exact pay ----------
  r := public.pay_open_period(qaclerk, jsonb_build_object(
        'period_start','2026-07-01','period_end','2026-07-31','pay_date','2026-08-01',
        'label','QA July 2026','currency','IQD'));
  pid := (r#>>'{period,id}')::uuid;
  perform public.pay_add_item(qaclerk, jsonb_build_object('period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
    'item_type','base_salary','amount',2000000,'currency','IQD','description','QA base'));
  perform public.pay_add_item(qaclerk, jsonb_build_object('period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
    'item_type','commission','amount',500000,'currency','IQD','description','QA commission'));
  perform public.pay_add_item(qaclerk, jsonb_build_object('period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
    'item_type','allowance','amount',200000,'currency','IQD','description','QA allowance'));
  perform public.pay_add_item(qaclerk, jsonb_build_object('period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
    'item_type','deduction','amount',100000,'currency','IQD','description','QA deduction'));

  perform public.pay_submit_period(qaclerk, pid, 'QA spec run');
  perform public.pay_decide_period(qaboss, pid, 'approve', null);
  perform public.pay_publish_period(qaboss, pid);

  -- Net across the stored items: 2,000,000 + 500,000 + 200,000 − 100,000.
  -- Amounts are stored positive; pay_item_sign() decides direction, so no
  -- caller can flip a deduction into earnings.
  perform pg_temp.chk('stored items net to exactly 2,600,000',
    (select sum(amount_iqd * public.pay_item_sign(item_type)) = 2600000
       from public.pay_items where period_id = pid));
  perform pg_temp.chk('stored earnings gross to exactly 2,700,000',
    (select sum(amount_iqd) filter (where public.pay_item_sign(item_type) = 1) = 2700000
       from public.pay_items where period_id = pid));

  -- The employee's own statement shows the same story.
  s := public.pay_my_statement(qaemp, '2026-07-01', '2026-07-31', null);
  perform pg_temp.chk('statement net is 2,600,000', (s#>>'{totals,net_iqd}')::numeric = 2600000);
  perform pg_temp.chk('statement base is 2,000,000', (s#>>'{totals,base_salary_iqd}')::numeric = 2000000);
  perform pg_temp.chk('statement commission is 500,000', (s#>>'{totals,commission_iqd}')::numeric = 500000);
  perform pg_temp.chk('statement deduction is 100,000', (s#>>'{totals,deduction_iqd}')::numeric = 100000);

  -- And the payslip: gross 2,700,000, net 2,600,000. Same rows, same answer.
  slip := public.pay_payslip(qaemp, pid, null);
  perform pg_temp.chk('payslip gross is 2,700,000', (slip->>'gross_iqd')::numeric = 2700000);
  perform pg_temp.chk('payslip net is 2,600,000', (slip->>'net_iqd')::numeric = 2600000);

  -- ---------- paid immutability + reversal ----------
  r := public.pay_record_payment(qaboss, jsonb_build_object(
        'period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
        'amount',2600000,'currency','IQD','paid_on','2026-08-01','method','Bank transfer'));
  payid := (r#>>'{payment,id}')::uuid;
  perform pg_temp.chk('the run is paid in full',
    (select status = 'paid' from public.pay_periods where id = pid));

  begin
    perform public.pay_add_item(qaclerk, jsonb_build_object('period_id',pid,'employee_email','zz-qa-one@larsaeng.test',
      'item_type','bonus','amount',1,'currency','IQD'));
    perform pg_temp.chk('a paid run rejects new items', false);
  exception when others then
    perform pg_temp.chk('a paid run rejects new items', sqlerrm like 'ACCT_IMMUTABLE:%');
  end;

  begin
    perform public.pay_reverse_payment(qaboss, payid, '');
    perform pg_temp.chk('a reversal without a reason is refused', false);
  exception when others then
    perform pg_temp.chk('a reversal without a reason is refused', sqlerrm like 'ACCT_TXN:%');
  end;

  r := public.pay_reverse_payment(qaboss, payid, 'QA: wrong account');
  perform pg_temp.chk('the reversal is a NEW row of −2,600,000',
    (r#>>'{reversal,amount_iqd}')::numeric = -2600000);
  perform pg_temp.chk('the original payment row still exists, marked reversed, amount intact',
    (select status = 'reversed' and amount_iqd = 2600000 from public.pay_payments where id = payid));
  perform pg_temp.chk('history keeps both rows',
    (select count(*) = 2 from public.pay_payments where period_id = pid));

  -- ---------- My Pay privacy with the QA users ----------
  s := public.pay_my_statement(qaemp, '2026-01-01', '2026-12-31', 'zz-qa-two@larsaeng.test');
  perform pg_temp.chk('employee One asking for employee Two gets refused or their own record only',
    coalesce(s#>>'{employee,email}','') <> 'zz-qa-two@larsaeng.test');

  s := public.pay_my_statement(qaboss, '2026-01-01', '2026-12-31', 'zz-qa-one@larsaeng.test');
  perform pg_temp.chk('an authorised viewer CAN open a named employee (viewed_by_self = false)',
    (s#>>'{employee,email}') = 'zz-qa-one@larsaeng.test' and (s->>'viewed_by_self')::boolean = false);
end;
$$;

-- ------------------------------------------------------------
-- Duplicate invoice reference: the ledger hard-rejects the second entry.
-- ------------------------------------------------------------
do $$
declare
  qaboss jsonb := '{"email":"zz-qa-boss@larsaeng.test","name":"QA Boss","role":"Owner / Super Admin"}'::jsonb;
  r jsonb;
begin
  perform public.acct_upsert_project(qaboss, jsonb_build_object(
    'id','zz-qa-prj-dup','code','ZZ-QA-DUP','name','QA Duplicate Fixture',
    'region','Iraq','type','Construction','status','Active','currency','IQD'));

  r := public.acct_post_transaction(qaboss, jsonb_build_object(
        'project_id','zz-qa-prj-dup','kind','expense','amount',5000000,'currency','IQD',
        'date','2026-07-10','status','pending','external_ref','ZZ-QA-INV-001','description','QA first'));
  perform pg_temp.chk('the first invoice posts', (r->>'ok')::boolean);

  begin
    r := public.acct_post_transaction(qaboss, jsonb_build_object(
          'project_id','zz-qa-prj-dup','kind','expense','amount',5000000,'currency','IQD',
          'date','2026-07-10','status','pending','external_ref','ZZ-QA-INV-001','description','QA second'));
    perform pg_temp.chk('the same invoice number a second time is rejected', false);
  exception when others then
    perform pg_temp.chk('the same invoice number a second time is rejected', true);
  end;
end;
$$;

-- ------------------------------------------------------------
-- The waiver rule (migration 015): a per-entry waiver must say why;
-- configured project/platform rules are untouched.
-- ------------------------------------------------------------
do $$
declare rule jsonb;
begin
  begin
    rule := public.acct_resolve_fee_rule('zz-qa-prj-dup', 'funding', null,
      '{"method":"waived","waiver_reason":""}'::jsonb);
    perform pg_temp.chk('waiving with no reason is refused', false);
  exception when others then
    perform pg_temp.chk('waiving with no reason is refused', sqlerrm like 'ACCT_VALIDATION:%');
  end;

  rule := public.acct_resolve_fee_rule('zz-qa-prj-dup', 'funding', null,
    '{"method":"waived","waiver_reason":"QA: client is a charity"}'::jsonb);
  perform pg_temp.chk('waiving with a reason resolves, reason preserved',
    (rule->>'waived')::boolean and rule->>'waiver_reason' = 'QA: client is a charity');

  rule := public.acct_resolve_fee_rule('zz-qa-prj-dup', 'funding', null, null);
  perform pg_temp.chk('with nothing configured the global default is 8%',
    (rule->>'rate')::numeric = 0.08 and rule->>'source' = 'platform_default');
end;
$$;

rollback;
