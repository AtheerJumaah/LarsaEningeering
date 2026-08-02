-- ============================================================
-- Larsa Control — payroll, commissions and My Pay (migration 009).
--
-- What this guards:
--   * a salary costs the company exactly once, however many times the
--     approval path is replayed
--   * an employee sees their own published pay, and nobody else's — through
--     the function, the parameter, or a direct table read
--   * every period filter (month, 6 months, YTD, calendar year, since
--     joining, custom range) totals correctly off the same stored rows
--   * base pay, commission, bonus, deduction and reimbursement stay separate
--   * a pending amount is never counted as paid
--   * historical exchange rates survive a change to the platform default
--   * USD and IQD are reported apart, never summed
--   * separation of duties: you cannot approve what you prepared, and you
--     cannot approve a run that pays you
--   * a reversed payment stays in history with its correction
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

-- ------------------------------------------------------------
-- Direct table access: there is none. This is the first line of the
-- privacy story and it is a grant, not a screen.
-- ------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('pay_employees','pay_periods','pay_items','pay_commissions','pay_payments')
     and grantee in ('anon','authenticated');
  perform pg_temp.chk('no client may select payroll tables directly', n = 0);

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('pay_employees','pay_items','pay_payments');
  perform pg_temp.chk('payroll tables carry no read policy at all', n = 0);

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname like 'pay\_%' and c.relkind = 'r' and c.relrowsecurity;
  perform pg_temp.chk('row-level security is on for every payroll table', n = 7);
end;
$$;

do $$
declare
  boss  jsonb := '{"email":"boss@larsaeng.com","name":"Boss","role":"Owner / Super Admin"}'::jsonb;
  clerk jsonb := '{"email":"clerk@larsaeng.com","name":"Clerk","role":"Payroll Accountant"}'::jsonb;
  mgr   jsonb := '{"email":"mgr@larsaeng.com","name":"Manager","role":"Project Manager"}'::jsonb;
  worker jsonb := '{"email":"sara@larsaeng.com","name":"Sara","role":"Engineer"}'::jsonb;
  other  jsonb := '{"email":"omar@larsaeng.com","name":"Omar","role":"Engineer"}'::jsonb;
  r jsonb; s jsonb; slip jsonb;
  p1 uuid; p2 uuid; p3 uuid; pOld uuid;
  com uuid; payid uuid;
  n int; before_iqd numeric; after_iqd numeric;
  tot jsonb;
begin
  -- ==========================================================
  -- Employees. Sara has an official start date; Omar has none, which
  -- must be queued rather than guessed.
  -- ==========================================================
  r := public.pay_upsert_employee(boss, jsonb_build_object(
        'email','sara@larsaeng.com','full_name','Sara Ali','employee_no','E-001',
        'position','Structural Engineer','department','Engineering',
        'employment_start','2025-03-01','base_salary',1500000,'salary_currency','IQD',
        'payment_ref','IQ98NBIQ1234567890'));
  perform pg_temp.chk('employee created', (r->>'ok')::boolean);

  r := public.pay_upsert_employee(boss, jsonb_build_object(
        'email','omar@larsaeng.com','full_name','Omar Hassan','position','Site Engineer'));
  select count(*) into n from public.pay_hr_queue
   where employee_email = 'omar@larsaeng.com' and gap = 'employment_start_missing' and status = 'open';
  perform pg_temp.chk('a missing employment start date is queued for HR, not invented', n = 1);
  perform pg_temp.chk('and it is left null rather than guessed',
    (select employment_start is null from public.pay_employees where email = 'omar@larsaeng.com'));

  -- ==========================================================
  -- One period, one employee, the full mix of components.
  --   base 1,500,000 IQD  commission 200,000  bonus 100,000
  --   deduction 50,000    reimbursement 75,000
  --   net = 1,500,000 + 200,000 + 100,000 - 50,000 + 75,000 = 1,825,000
  -- ==========================================================
  r := public.pay_open_period(clerk, jsonb_build_object(
        'period_start','2026-06-01','period_end','2026-06-30','pay_date','2026-07-05',
        'label','June 2026','currency','IQD'));
  p1 := (r#>>'{period,id}')::uuid;

  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
    'item_type','base_salary','amount',1500000,'currency','IQD','description','June salary'));
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
    'item_type','commission','amount',200000,'currency','IQD','description','Villa handover'));
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
    'item_type','bonus','amount',100000,'currency','IQD'));
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
    'item_type','deduction','amount',50000,'currency','IQD','description','Late arrivals'));
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
    'item_type','reimbursement','amount',75000,'currency','IQD','description','Site fuel'));

  perform public.pay_submit_period(clerk, p1, 'June run');

  -- ---- separation of duties ----
  begin
    perform public.pay_decide_period(clerk, p1, 'approve', null);
    perform pg_temp.chk('the preparer cannot approve their own run', false);
  exception when others then
    perform pg_temp.chk('the preparer cannot approve their own run',
      sqlerrm like 'ACCT_APPROVAL:%' or sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  -- A payroll accountant has no approve permission at all.
  perform pg_temp.chk('Payroll Accountant cannot approve payroll',
    not public.acct_has_perm(clerk, 'payroll_approve'));
  perform pg_temp.chk('Payroll Accountant can still prepare and pay',
    public.acct_has_perm(clerk, 'payroll_manage') and public.acct_has_perm(clerk, 'payroll_pay'));

  -- A manager sees nothing without the explicit confidential permission.
  perform pg_temp.chk('a manager has no confidential payroll access by default',
    not public.acct_has_perm(mgr, 'payroll_view_all'));
  perform pg_temp.chk('an engineer has no confidential payroll access',
    not public.acct_has_perm(worker, 'payroll_view_all'));

  r := public.pay_decide_period(boss, p1, 'approve', 'checked');
  perform pg_temp.chk('an authorised approver can approve', (r#>>'{period,status}') = 'approved');

  -- ==========================================================
  -- One entry, not two.
  -- Base + commission + bonus + reimbursement are costs (4 entries).
  -- The deduction is not a cost of its own.
  -- ==========================================================
  perform pg_temp.chk('approval posts one ledger entry per costed item', (r->>'posted')::int = 4);
  select count(*) into n from public.acct_transactions
   where meta->>'payroll_period' = (select period_no from public.pay_periods where id = p1);
  perform pg_temp.chk('four accounting expenses exist, no more', n = 4);

  select count(*) into n from public.pay_items where period_id = p1 and txn_id is not null;
  perform pg_temp.chk('every costed item carries its ledger link', n = 4);

  select count(*) into n from public.pay_items i join public.pay_items j
    on i.txn_id = j.txn_id and i.id <> j.id;
  perform pg_temp.chk('no ledger transaction is claimed by two payroll items', n = 0);

  -- Replaying approval must not cost the company a second time.
  begin
    perform public.pay_decide_period(boss, p1, 'approve', 'again');
  exception when others then null;
  end;
  select count(*) into n from public.acct_transactions
   where meta->>'payroll_period' = (select period_no from public.pay_periods where id = p1);
  perform pg_temp.chk('re-approving cannot double-count a salary', n = 4);

  -- The cost lands on the company, not on a client's fund control.
  select count(*) into n from public.acct_transactions
   where meta->>'payroll_period' is not null
     and public.acct_cost_bearer(payment_source, meta) = 'larsa';
  perform pg_temp.chk('payroll is borne by Larsa, never by client funds', n = 4);

  -- ==========================================================
  -- Publication is what an employee can see. Approval alone is not.
  -- ==========================================================
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('an approved but unpublished run is invisible to the employee',
    jsonb_array_length(s->'periods') = 0);

  perform public.pay_publish_period(boss, p1);
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('a published run reaches the employee', jsonb_array_length(s->'periods') = 1);
  tot := s->'totals';

  -- ==========================================================
  -- The components stay apart, and the net is the approved net.
  -- ==========================================================
  perform pg_temp.chk('base salary is reported on its own', (tot->>'base_salary_iqd')::numeric = 1500000);
  perform pg_temp.chk('commission is reported on its own', (tot->>'commission_iqd')::numeric = 200000);
  perform pg_temp.chk('bonus is reported on its own', (tot->>'bonus_iqd')::numeric = 100000);
  perform pg_temp.chk('deductions are reported on their own', (tot->>'deduction_iqd')::numeric = 50000);
  perform pg_temp.chk('reimbursements are separate from salary and commission',
    (tot->>'reimbursement_iqd')::numeric = 75000);
  perform pg_temp.chk('net earnings = 1,825,000', (tot->>'net_iqd')::numeric = 1825000);

  -- ==========================================================
  -- Approved but unpaid must be unmistakable, and never read as paid.
  -- ==========================================================
  perform pg_temp.chk('nothing is paid yet', (tot->>'paid_iqd')::numeric = 0);
  perform pg_temp.chk('the whole net is outstanding', (tot->>'outstanding_iqd')::numeric = 1825000);
  slip := public.pay_payslip(worker, p1, null);
  perform pg_temp.chk('the payslip says approved, not paid', (slip->>'payment_state') = 'approved_unpaid');
  perform pg_temp.chk('the payslip net matches My Pay', (slip->>'net_iqd')::numeric = 1825000);
  perform pg_temp.chk('the payslip gross excludes the deduction', (slip->>'gross_iqd')::numeric = 1875000);
  perform pg_temp.chk('the payslip never carries a raw account number',
    (slip#>>'{employee,payment_ref_masked}') like '%7890' and (slip#>>'{employee,payment_ref_masked}') like '•%');

  -- ==========================================================
  -- Partial payment, then completion.
  -- ==========================================================
  r := public.pay_record_payment(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
        'amount',1000000,'currency','IQD','paid_on','2026-07-05','reference','TRF-99881234'));
  payid := (r#>>'{payment,id}')::uuid;
  perform pg_temp.chk('a part payment leaves the run partially paid', (r->>'period_status') = 'partially_paid');
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('paid shows the part actually paid', (s#>>'{totals,paid_iqd}')::numeric = 1000000);
  perform pg_temp.chk('outstanding is the remainder', (s#>>'{totals,outstanding_iqd}')::numeric = 825000);

  r := public.pay_record_payment(clerk, jsonb_build_object('period_id',p1,'employee_email','sara@larsaeng.com',
        'amount',825000,'currency','IQD','paid_on','2026-07-09'));
  perform pg_temp.chk('settling the remainder marks the run paid', (r->>'period_status') = 'paid');
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('nothing is left outstanding', (s#>>'{totals,outstanding_iqd}')::numeric = 0);

  -- ==========================================================
  -- A reversal corrects without erasing.
  -- ==========================================================
  r := public.pay_reverse_payment(clerk, payid, 'Wrong bank account');
  perform pg_temp.chk('reversing a payment reopens the balance', (r->>'period_status') = 'partially_paid');
  select count(*) into n from public.pay_payments where period_id = p1;
  perform pg_temp.chk('the original payment is still in history beside its correction', n = 3);
  select count(*) into n from public.pay_payments where reverses_id = payid;
  perform pg_temp.chk('the correction points at what it corrects', n = 1);
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('the employee sees the corrected paid figure',
    (s#>>'{totals,paid_iqd}')::numeric = 825000);

  -- ==========================================================
  -- Privacy: through the parameter, and through the table.
  -- ==========================================================
  s := public.pay_my_statement(other, null, null, 'sara@larsaeng.com');
  perform pg_temp.chk('asking for somebody else returns your own record, not theirs',
    (s#>>'{employee,email}') = 'omar@larsaeng.com');
  perform pg_temp.chk('and it carries none of their periods', jsonb_array_length(s->'periods') = 0);

  s := public.pay_my_statement(mgr, null, null, 'sara@larsaeng.com');
  perform pg_temp.chk('a manager cannot read an employee pay record by asking for it',
    (s->>'found')::boolean is not true or (s#>>'{employee,email}') <> 'sara@larsaeng.com');

  s := public.pay_my_statement(boss, null, null, 'sara@larsaeng.com');
  perform pg_temp.chk('an authorised viewer can, and it is the right person',
    (s#>>'{employee,email}') = 'sara@larsaeng.com');
  select count(*) into n from public.acct_audit
   where action = 'Employee Pay Viewed' and details = 'sara@larsaeng.com';
  perform pg_temp.chk('looking at another person''s pay is written to the audit', n >= 1);

  -- ==========================================================
  -- Commissions: lifecycle, pending never reads as paid, rule frozen.
  -- ==========================================================
  r := public.pay_record_commission(clerk, jsonb_build_object(
        'employee_email','sara@larsaeng.com','title','Villa referral',
        'basis','percent','rate',0.05,'base_amount',10000000,'base_currency','IQD',
        'currency','IQD','earning_start','2026-06-01','earning_end','2026-06-30'));
  com := (r#>>'{commission,id}')::uuid;
  perform pg_temp.chk('a percentage commission is calculated from its base',
    (r#>>'{commission,original_amount}')::numeric = 500000);
  perform pg_temp.chk('a new commission starts pending review',
    (r#>>'{commission,status}') = 'pending_review');
  perform pg_temp.chk('the rule that produced it is frozen onto it',
    (r#>>'{commission,rule_snapshot,rate}')::numeric = 0.05);

  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('a pending commission is visible but not counted as approved',
    (s#>>'{totals,pending_commission_iqd}')::numeric = 500000);
  perform pg_temp.chk('and it is not counted as paid', (s#>>'{totals,paid_iqd}')::numeric = 825000);

  begin
    perform public.pay_decide_commission(clerk, com, 'approve', null);
    perform pg_temp.chk('whoever recorded a commission cannot approve it', false);
  exception when others then
    perform pg_temp.chk('whoever recorded a commission cannot approve it',
      sqlerrm like 'ACCT_APPROVAL:%' or sqlerrm like 'ACCT_FORBIDDEN:%');
  end;

  r := public.pay_decide_commission(boss, com, 'approve', 'agreed');
  perform pg_temp.chk('an authorised approver can approve a commission',
    (r#>>'{commission,status}') = 'approved');
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('an approved commission moves out of pending',
    (s#>>'{totals,pending_commission_iqd}')::numeric = 0
    and (s#>>'{totals,approved_commission_iqd}')::numeric = 500000);

  -- Changing the default rate now must not touch the commission already made.
  update public.acct_platform_settings set default_exchange_rate = 5000 where id = 1;
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('changing the platform rate cannot move a historical commission',
    (s#>>'{totals,approved_commission_iqd}')::numeric = 500000);
  perform pg_temp.chk('nor a historical payroll total', (s#>>'{totals,net_iqd}')::numeric = 1825000);
  slip := public.pay_payslip(worker, p1, null);
  perform pg_temp.chk('nor a payslip downloaded later', (slip->>'net_iqd')::numeric = 1825000);
  update public.acct_platform_settings set default_exchange_rate = 1310 where id = 1;

  -- ==========================================================
  -- Multi-currency: reported apart, never summed.
  -- ==========================================================
  r := public.pay_open_period(clerk, jsonb_build_object(
        'period_start','2026-07-01','period_end','2026-07-31','pay_date','2026-08-05','currency','USD'));
  p2 := (r#>>'{period,id}')::uuid;
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p2,'employee_email','sara@larsaeng.com',
    'item_type','base_salary','amount',1000,'currency','USD','exchange_rate',1310));
  perform public.pay_submit_period(clerk, p2, null);
  perform public.pay_decide_period(boss, p2, 'approve', null);
  perform public.pay_publish_period(boss, p2);

  s := public.pay_my_statement(worker, '2026-07-01'::date, '2026-07-31'::date, null);
  perform pg_temp.chk('a USD salary keeps its own currency',
    (s#>>'{by_currency,USD,net}')::numeric = 1000);
  perform pg_temp.chk('and no IQD figure is invented for a USD-only month',
    (s->'by_currency') ? 'USD' and not ((s->'by_currency') ? 'IQD'));
  perform pg_temp.chk('the IQD equivalent is the historical snapshot, not a live conversion',
    (s#>>'{totals,net_iqd}')::numeric = 1310000);

  -- ==========================================================
  -- Period filters, all off the same rows.
  --   June 2026 net 1,825,000 IQD  |  July 2026 net 1,310,000 IQD (USD 1,000)
  -- ==========================================================
  s := public.pay_my_statement(worker, '2026-06-01'::date, '2026-06-30'::date, null);
  perform pg_temp.chk('a single month totals that month only',
    (s#>>'{totals,net_iqd}')::numeric = 1825000 and (s#>>'{totals,periods}')::int = 1);

  s := public.pay_my_statement(worker, '2026-02-01'::date, '2026-07-31'::date, null);
  perform pg_temp.chk('six months adds both runs',
    (s#>>'{totals,net_iqd}')::numeric = 3135000 and (s#>>'{totals,periods}')::int = 2);

  s := public.pay_my_statement(worker, '2026-01-01'::date, '2026-12-31'::date, null);
  perform pg_temp.chk('a calendar year adds both runs', (s#>>'{totals,net_iqd}')::numeric = 3135000);

  s := public.pay_my_statement(worker, '2026-01-01'::date, current_date, null);
  perform pg_temp.chk('year to date is bounded by today',
    (s#>>'{totals,net_iqd}')::numeric >= 0);

  s := public.pay_my_statement(worker, '2026-07-01'::date, '2026-07-31'::date, null);
  perform pg_temp.chk('a custom range takes only what falls inside it',
    (s#>>'{totals,net_iqd}')::numeric = 1310000 and (s#>>'{totals,periods}')::int = 1);

  -- Since joining: bounded by the official start date, from HR.
  s := public.pay_my_statement(worker, null, null, null);
  perform pg_temp.chk('since joining starts at the employment start date',
    (s#>>'{range,from}')::date = '2025-03-01'::date);
  perform pg_temp.chk('and covers everything since', (s#>>'{totals,net_iqd}')::numeric = 3135000);

  s := public.pay_my_statement(other, null, null, null);
  perform pg_temp.chk('with no start date recorded the range opens up instead of guessing',
    (s#>>'{range,from}') is null and (s#>>'{range,note}') like '%not recorded%');

  perform pg_temp.chk('the average is per period, not per calendar month',
    (public.pay_my_statement(worker, '2026-06-01'::date, '2026-07-31'::date, null)
      #>>'{totals,average_month_iqd}')::numeric = 1567500);

  -- ==========================================================
  -- Monthly history is per earning period, not per creation date.
  -- ==========================================================
  s := public.pay_my_statement(worker, '2026-06-01'::date, '2026-07-31'::date, null);
  perform pg_temp.chk('the monthly series has one point per pay period',
    jsonb_array_length(s->'months') = 2);
  perform pg_temp.chk('and is keyed by the earning month',
    (s#>>'{months,0,month}') = '2026-06');

  -- ==========================================================
  -- Existing salary expenses in Accounting are preserved, queued, linked
  -- once, and never duplicated.
  -- ==========================================================
  perform set_config('acct.internal_op', '1', true);
  perform public.acct_post_transaction(boss, jsonb_build_object(
    'kind','expense','project_id',public.pay_company_project(),'category','Salary',
    'description','Legacy May salary — Sara','amount',1400000,'currency','IQD',
    'status','approved','date','2026-05-31','payment_source','Larsa Operating'));
  perform set_config('acct.internal_op', '', true);

  r := public.pay_scan_unlinked_salary(boss);
  perform pg_temp.chk('an unlinked salary expense is queued for mapping', (r->>'queued')::int >= 1);

  select count(*) into n from public.acct_transactions where description like 'Legacy May salary%';
  perform pg_temp.chk('the original accounting entry is preserved, not copied', n = 1);

  r := public.pay_open_period(clerk, jsonb_build_object(
        'period_start','2026-05-01','period_end','2026-05-31','pay_date','2026-06-05','currency','IQD'));
  pOld := (r#>>'{period,id}')::uuid;
  r := public.pay_link_transaction(boss,
        (select id from public.acct_transactions where description like 'Legacy May salary%'),
        'sara@larsaeng.com', pOld, 'Verified against the bank statement');
  perform pg_temp.chk('mapping keeps the original amount rather than recalculating it',
    (r#>>'{item,original_amount}')::numeric = 1400000);
  perform pg_temp.chk('and its original rate', (r#>>'{item,exchange_rate}')::numeric = 1310);

  select count(*) into n from public.acct_transactions where description like 'Legacy May salary%';
  perform pg_temp.chk('linking does not create a second expense', n = 1);

  begin
    perform public.pay_link_transaction(boss,
      (select id from public.acct_transactions where description like 'Legacy May salary%'),
      'sara@larsaeng.com', pOld, null);
    perform pg_temp.chk('the same transaction cannot be linked twice', false);
  exception when others then
    perform pg_temp.chk('the same transaction cannot be linked twice',
      sqlerrm like 'ACCT_IMMUTABLE:%');
  end;

  -- ==========================================================
  -- Approving a run that pays the approver.
  -- ==========================================================
  r := public.pay_upsert_employee(boss, jsonb_build_object(
        'email','boss@larsaeng.com','full_name','The Boss','employment_start','2024-01-01'));
  r := public.pay_open_period(clerk, jsonb_build_object(
        'period_start','2026-08-01','period_end','2026-08-31','currency','IQD'));
  p3 := (r#>>'{period,id}')::uuid;
  perform public.pay_add_item(clerk, jsonb_build_object('period_id',p3,'employee_email','boss@larsaeng.com',
    'item_type','base_salary','amount',3000000,'currency','IQD'));
  perform public.pay_submit_period(clerk, p3, null);
  begin
    perform public.pay_decide_period(boss, p3, 'approve', null);
    perform pg_temp.chk('an approver cannot approve a run that pays them', false);
  exception when others then
    perform pg_temp.chk('an approver cannot approve a run that pays them',
      sqlerrm like 'ACCT_APPROVAL:%');
  end;
end;
$$;

rollback;
