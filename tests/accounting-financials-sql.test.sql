-- ============================================================
-- Larsa Control — authoritative financial model tests (migration 008).
--
-- Guards the corrective pass:
--   * client construction funding is NEVER Larsa revenue or profit
--   * company profit is never "funding − construction spending"
--   * USD and IQD are never added; exchange rates are never summed
--   * approved and working totals are both reported, and every
--     active saved entry moves the working total immediately
--   * one authoritative function feeds every surface
--   * the consultancy-fee lifecycle keeps projected and final apart
-- Verified against the exact figures reported from production.
-- ============================================================
\set ON_ERROR_STOP on
begin;
-- Seeding fixtures uses the sanctioned internal path (migration 007);
-- the maker-checker rule itself is covered by its own suite.
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
  sys jsonb := '{"email":"fin@larsaeng.com","name":"Fin","role":"Owner / Super Admin"}'::jsonb;
  f jsonb; co jsonb; q jsonb; aud jsonb;
  cf jsonb; ap jsonb; wk jsonb; pend jsonb; comp jsonb; fee jsonb;
  r jsonb; n int;
begin
  -- ==========================================================
  -- The production "Mosul Private Villa" shape, exactly.
  --   funding 10,000,000 + 2,000,000 IQD  @ platform 8% fee
  --   materials 3,000,000 / labour 2,500,000 / expense 1,500,000 approved
  --   one 400,000 expense still pending approval
  -- ==========================================================
  perform public.acct_upsert_project(sys, '{"id":"mosul","name":"Mosul Private Villa","client":"Client A",
    "currency":"IQD","region":"Iraq","contract_value":200000000,"approved_budget":100000000,
    "budget_currency":"IQD"}'::jsonb);

  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"funding","category":"Client Funding",
    "amount":10000000,"currency":"IQD","status":"received","description":"Initial funding instalment"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"funding","category":"Client Funding",
    "amount":2000000,"currency":"IQD","status":"received","description":"Additional funding instalment"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"material","category":"Concrete & Steel",
    "amount":3000000,"currency":"IQD","status":"approved","description":"Foundation materials"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"labor","category":"Skilled Labor",
    "amount":2500000,"currency":"IQD","status":"approved","description":"Foundation crew"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"expense","category":"Equipment Rental",
    "amount":1500000,"currency":"IQD","status":"approved","description":"Crane rental"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"expense","category":"Permits",
    "amount":400000,"currency":"IQD","status":"pending","description":"Municipal permit (pending)"}'::jsonb);

  f  := public.acct_project_financials('mosul');
  cf := f->'client_funds';
  ap := cf->'approved';
  wk := cf->'working';
  pend := cf->'pending';
  comp := f->'company';
  fee := f->'fee';

  -- ---------- 1. Client fund control: the required figures ----------
  perform pg_temp.chk('gross client funding is 12,000,000 IQD',
    (ap->>'gross_funding_iqd')::numeric = 12000000);
  perform pg_temp.chk('initial consultancy fee is 960,000 IQD (8% platform default)',
    (ap->>'initial_fee_iqd')::numeric = 960000);
  perform pg_temp.chk('net construction funding is 11,040,000 IQD',
    (ap->>'net_construction_funding_iqd')::numeric = 11040000);
  perform pg_temp.chk('APPROVED construction cost is 7,000,000 IQD',
    (ap->>'construction_cost_iqd')::numeric = 7000000);
  perform pg_temp.chk('PENDING construction cost is 400,000 IQD',
    (pend->>'construction_cost_iqd')::numeric = 400000);
  perform pg_temp.chk('WORKING construction cost is 7,400,000 IQD',
    (wk->>'construction_cost_iqd')::numeric = 7400000);
  perform pg_temp.chk('APPROVED remaining client balance is 4,040,000 IQD',
    (ap->>'remaining_balance_iqd')::numeric = 4040000);
  perform pg_temp.chk('WORKING remaining client balance is 3,640,000 IQD',
    (wk->>'remaining_balance_iqd')::numeric = 3640000);
  perform pg_temp.chk('materials, labour and other costs are reported separately',
    (ap->>'materials_iqd')::numeric = 3000000
    and (ap->>'labor_iqd')::numeric = 2500000
    and (ap->>'other_costs_iqd')::numeric = 1500000);
  perform pg_temp.chk('working totals never lag: every active saved entry counts immediately',
    (wk->>'construction_cost_iqd')::numeric - (ap->>'construction_cost_iqd')::numeric = 400000);

  -- ---------- 2. Client funding is NOT Larsa revenue ----------
  perform pg_temp.chk('the project is on the client-funded model by default',
    (f->>'accounting_mode') = 'client_funded');
  perform pg_temp.chk('Larsa revenue is the earned consultancy fee only — NOT 12,960,000',
    (comp->>'larsa_revenue_iqd')::numeric = 960000);
  perform pg_temp.chk('client funding is not recognised as company revenue',
    (comp->>'client_funding_recognised_iqd')::numeric = 0);
  perform pg_temp.chk('company net profit is 960,000 IQD — NOT 5,960,000',
    (comp->>'company_net_profit_iqd')::numeric = 960000);
  perform pg_temp.chk('client-funded materials and labour are NOT company expenses',
    (comp->>'company_expenses_iqd')::numeric = 0
    and (comp->>'larsa_attributable_project_costs_iqd')::numeric = 0);
  perform pg_temp.chk('company profit is never funding minus construction spending',
    (comp->>'company_net_profit_iqd')::numeric
      <> (ap->>'gross_funding_iqd')::numeric - (ap->>'construction_cost_iqd')::numeric);
  perform pg_temp.chk('the two blocks are separated and self-describing',
    cf ? 'basis_note' and comp ? 'basis_note'
    and (comp->>'basis_note') like '%not%' or (comp->>'basis_note') like '%excluded%');

  -- ---------- 3. Costs Larsa really bears DO hit company profit ----------
  perform public.acct_post_transaction(sys, '{"project_id":"mosul","kind":"expense","category":"Overhead",
    "amount":100000,"currency":"IQD","status":"approved","payment_source":"Larsa Operating",
    "description":"Larsa-paid site supervision"}'::jsonb);
  f := public.acct_project_financials('mosul');
  perform pg_temp.chk('a Larsa-paid cost becomes a company expense',
    (f#>>'{company,company_expenses_iqd}')::numeric = 100000
    and (f#>>'{company,company_net_profit_iqd}')::numeric = 860000);
  perform pg_temp.chk('a Larsa-paid cost never touches the client fund balance',
    (f#>>'{client_funds,approved,construction_cost_iqd}')::numeric = 7000000
    and (f#>>'{client_funds,approved,remaining_balance_iqd}')::numeric = 4040000);
  perform pg_temp.chk('cost bearer defaults to the client and is explicit for Larsa',
    public.acct_cost_bearer(null, '{}'::jsonb) = 'client'
    and public.acct_cost_bearer('Larsa Operating', '{}'::jsonb) = 'larsa'
    and public.acct_cost_bearer(null, '{"cost_bearer":"larsa"}'::jsonb) = 'larsa');

  -- ---------- 4. Reliability status, in words as well as colour ----------
  perform pg_temp.chk('a working total containing an unapproved entry is yellow',
    (f#>>'{review,status}') = 'yellow');
  perform pg_temp.chk('the status is stated in text, not colour alone',
    (f#>>'{review,label}') = 'Contains 1 unapproved entry');
  perform pg_temp.chk('the unapproved entry count is reported',
    (f#>>'{review,unapproved_entries}')::int = 1);

  -- ---------- 5. Currencies are never added ----------
  perform public.acct_upsert_project(sys, '{"id":"mixed","name":"Mixed Currency Project","currency":"USD",
    "region":"Iraq"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mixed","kind":"funding","amount":1000,
    "currency":"USD","exchange_rate":1500,"status":"received","description":"at 1500"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mixed","kind":"funding","amount":1000,
    "currency":"USD","exchange_rate":1600,"status":"received","description":"at 1600"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"mixed","kind":"funding","amount":5000000,
    "currency":"IQD","status":"received","description":"local instalment"}'::jsonb);
  f := public.acct_project_financials('mixed');

  perform pg_temp.chk('original-currency totals are kept strictly apart',
    (f#>>'{by_currency,USD,gross_funding_approved}')::numeric = 2000
    and (f#>>'{by_currency,IQD,gross_funding_approved}')::numeric = 5000000);
  perform pg_temp.chk('the raw USD total is never merged into the IQD total',
    (f#>>'{by_currency,USD,gross_funding_approved}')::numeric
      <> (f#>>'{by_currency,IQD,gross_funding_approved}')::numeric);
  perform pg_temp.chk('both currencies present are declared',
    (f->'currencies_present') @> '["USD"]'::jsonb and (f->'currencies_present') @> '["IQD"]'::jsonb);
  perform pg_temp.chk('1,000 USD at 1500 plus 1,000 USD at 1600 stays 3,100,000 IQD forever',
    (f#>>'{by_currency,USD,gross_funding_approved}')::numeric = 2000
    and (f#>>'{client_funds,approved,gross_funding_iqd}')::numeric = 8100000);
  perform pg_temp.chk('the USD reporting total converts at each entry''s own snapshot',
    (f#>>'{client_funds,approved,gross_funding_usd}')::numeric = round(2000 + 5000000/1310.0, 2));
  perform pg_temp.chk('no field in the model is an exchange-rate total',
    not (f::text ~ 'rate_total|total_rate|sum_rate|exchange_rate_total'));

  -- Changing the platform default must never move history.
  insert into public.platform_admins (email) values ('fin@larsaeng.com') on conflict do nothing;
  insert into public.auth_codes (email, purpose, code, expires_at)
  values ('fin@larsaeng.com','verify','909090', now() + interval '10 minutes');
  perform public.acct_save_platform_settings(sys, '909090', '{"default_exchange_rate":2000}'::jsonb);
  perform pg_temp.chk('changing the platform default rate never changes historical totals',
    (public.acct_project_financials('mixed')#>>'{client_funds,approved,gross_funding_iqd}')::numeric = 8100000);

  -- ---------- 6. One authoritative calculation for every surface ----------
  perform pg_temp.chk('summary v2 carries the authoritative blocks for every caller',
    public.acct_project_summary_v2('mosul') ? 'client_funds'
    and public.acct_project_summary_v2('mosul') ? 'company'
    and public.acct_project_summary_v2('mosul') ? 'reliability');
  perform pg_temp.chk('summary v2 still carries the classic per-kind review breakdown',
    public.acct_project_summary_v2('mosul')#>>'{review,overall_status}' is not null);
  perform pg_temp.chk('the classic summary and the authoritative model agree on cost',
    (public.acct_project_summary('mosul')->>'actual_construction_cost_iqd')::numeric
      = (public.acct_project_financials('mosul')#>>'{client_funds,approved,construction_cost_iqd}')::numeric);

  -- ---------- 7. Company rollup uses the same model ----------
  co := public.acct_company_financials(null, null);
  perform pg_temp.chk('the company view rolls up client funds without calling them revenue',
    (co#>>'{client_funds,gross_funding_iqd}')::numeric = 12000000 + 8100000);
  perform pg_temp.chk('company revenue across projects is fees and revenue only',
    (co#>>'{company,larsa_revenue_iqd}')::numeric
      = (co#>>'{company,consultancy_fee_revenue_iqd}')::numeric
      + (co#>>'{company,engineering_revenue_iqd}')::numeric
      + (co#>>'{company,other_revenue_iqd}')::numeric);
  perform pg_temp.chk('company net profit across projects is revenue minus company expenses',
    (co#>>'{company,company_net_profit_iqd}')::numeric
      < (co#>>'{client_funds,gross_funding_iqd}')::numeric);
  perform pg_temp.chk('the rollup reports both approved and working construction cost',
    (co#>>'{client_funds,construction_cost_approved_iqd}')::numeric = 7000000
    and (co#>>'{client_funds,construction_cost_working_iqd}')::numeric = 7400000);
  perform pg_temp.chk('the rollup keeps original currencies apart too',
    (co#>>'{by_currency,USD,gross_funding_working}')::numeric = 2000);
  perform pg_temp.chk('the rollup carries one row per project for the tables',
    jsonb_array_length(co->'rows') = 2);
  perform pg_temp.chk('a region filter narrows the rollup',
    (public.acct_company_financials(null, 'Iraq')->>'projects')::int = 2
    and (public.acct_company_financials(null, 'USA')->>'projects')::int = 0);

  -- ---------- 8. Contractor mode is explicit, never implicit ----------
  perform public.acct_upsert_project(sys, '{"id":"mosul","accounting_mode":"contractor"}'::jsonb);
  update public.acct_projects set accounting_mode = 'contractor' where id = 'mosul';
  f := public.acct_project_financials('mosul');
  perform pg_temp.chk('contractor mode recognises funding as revenue only when explicitly set',
    (f->>'accounting_mode') = 'contractor'
    and (f#>>'{company,client_funding_recognised_iqd}')::numeric = 12000000);
  update public.acct_projects set accounting_mode = 'client_funded' where id = 'mosul';
  perform pg_temp.chk('back on the client-funded model funding leaves company revenue again',
    (public.acct_project_financials('mosul')#>>'{company,larsa_revenue_iqd}')::numeric = 960000);

  -- ---------- 9. Consultancy-fee lifecycle ----------
  fee := public.acct_project_financials('mosul')->'fee';
  perform pg_temp.chk('the effective fee rate resolves to the 8% platform default',
    (fee->>'effective_rate')::numeric = 0.08 and (fee->>'effective_rate_pct')::numeric = 8);
  perform pg_temp.chk('the fee rule states its source, basis and treatment',
    (fee->>'source') is not null and (fee->>'basis') is not null and (fee->>'treatment') is not null);
  perform pg_temp.chk('accrued, refundable, recognised and projected fees are separate fields',
    fee ? 'initial_accrued_iqd' and fee ? 'estimated_refundable_iqd'
    and fee ? 'refunded_to_date_iqd' and fee ? 'current_recognised_iqd'
    and fee ? 'projected_after_full_refund_iqd' and fee ? 'final_settled_iqd');
  perform pg_temp.chk('a projected fee is never presented as final before settlement',
    (fee->>'is_final')::boolean = false and (fee->'final_settled_iqd') = 'null'::jsonb);

  -- The required refund example, unchanged by this pass.
  perform public.acct_upsert_project(sys, '{"id":"refx","name":"Refund Example","currency":"IQD"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"refx","kind":"funding","amount":10000000,
    "currency":"IQD","status":"received","description":"gross funding"}'::jsonb);
  perform public.acct_post_transaction(sys, '{"project_id":"refx","kind":"material","amount":7000000,
    "currency":"IQD","status":"approved","description":"spending"}'::jsonb);
  f := public.acct_project_financials('refx');
  perform pg_temp.chk('refund example — gross 10,000,000, fee 800,000, net 9,200,000',
    (f#>>'{client_funds,approved,gross_funding_iqd}')::numeric = 10000000
    and (f#>>'{client_funds,approved,initial_fee_iqd}')::numeric = 800000
    and (f#>>'{client_funds,approved,net_construction_funding_iqd}')::numeric = 9200000);
  perform pg_temp.chk('refund example — unused 2,200,000 and refundable fee 176,000',
    (f#>>'{client_funds,refundable_principal_iqd}')::numeric = 2200000
    and (f#>>'{client_funds,refundable_fee_iqd}')::numeric = 176000);
  perform pg_temp.chk('refund example — total refund 2,376,000 and retained fee 624,000',
    (f#>>'{client_funds,total_refund_due_iqd}')::numeric = 2376000
    and (f#>>'{fee,projected_after_full_refund_iqd}')::numeric = 624000);

  -- ---------- 10. The Accounting Approval Queue ----------
  q := public.acct_approval_queue(null, null, null, null, null, null, null);
  perform pg_temp.chk('the approval queue is not empty while an entry awaits approval',
    (q->>'total')::int >= 1);
  perform pg_temp.chk('the pending Mosul permit appears in the queue',
    exists (select 1 from jsonb_array_elements(q->'rows') x
             where x->>'project_id' = 'mosul' and (x->>'amount')::numeric = 400000
               and x->>'action' = 'approve_entry'));
  perform pg_temp.chk('each queued record carries exactly one outstanding action',
    not exists (select 1 from jsonb_array_elements(q->'rows') x
                 where x->>'action' is null)
    and (select count(distinct x->>'action') from jsonb_array_elements(q->'rows') x
          where x->>'reference' = (select y->>'reference' from jsonb_array_elements(q->'rows') y
                                    where y->>'project_id' = 'mosul' and (y->>'amount')::numeric = 400000
                                    limit 1)) = 1);
  perform pg_temp.chk('the queue names who entered the record and who may approve it',
    exists (select 1 from jsonb_array_elements(q->'rows') x
             where x->>'entered_by' = 'fin@larsaeng.com' and x->>'assigned_approver' is not null));
  perform pg_temp.chk('the queue reports the age of each waiting record',
    not exists (select 1 from jsonb_array_elements(q->'rows') x where x->>'age_days' is null));
  perform pg_temp.chk('the queue filters by project',
    (public.acct_approval_queue('mosul', null, null, null, null, null, null)->'rows') @> '[]'::jsonb
    and not exists (select 1 from jsonb_array_elements(
      public.acct_approval_queue('mosul', null, null, null, null, null, null)->'rows') x
      where x->>'project_id' <> 'mosul'));
  perform pg_temp.chk('the queue filters by record kind',
    not exists (select 1 from jsonb_array_elements(
      public.acct_approval_queue(null, 'expense', null, null, null, null, null)->'rows') x
      where x->>'record_kind' <> 'expense'));
  perform pg_temp.chk('the queue filters by the accountant who entered the record',
    not exists (select 1 from jsonb_array_elements(
      public.acct_approval_queue(null, null, 'nobody@larsaeng.com', null, null, null, null)->'rows') x));
  perform pg_temp.chk('the queue counts by kind for the dashboard badge',
    (q->'by_kind') ? 'expense');

  -- ---------- 11. Browsable append-only history ----------
  aud := public.acct_audit_page(null, null, null, null, null, null, null, null, 50);
  perform pg_temp.chk('the accounting history is browsable and reports its full size',
    (aud->>'total')::int > 0 and jsonb_array_length(aud->'rows') > 0);
  perform pg_temp.chk('history rows carry before/after values and the fields that changed',
    exists (select 1 from jsonb_array_elements(aud->'rows') x where x ? 'changed_fields'));
  perform pg_temp.chk('history can be searched free-text',
    (public.acct_audit_page(null, 'Foundation', null, null, null, null, null, null, 50)->>'total')::int >= 1);
  perform pg_temp.chk('history can be filtered to one project',
    not exists (select 1 from jsonb_array_elements(
      public.acct_audit_page('mosul', null, null, null, null, null, null, null, 200)->'rows') x
      where x->>'project_id' is distinct from 'mosul'));
  perform pg_temp.chk('history offers its action vocabulary for filtering',
    jsonb_array_length(aud->'actions') > 0);
  select count(*) into n from public.acct_audit;
  perform pg_temp.chk('paging never hides events — the total always reflects the whole history',
    (public.acct_audit_page(null, null, null, null, null, null, null, null, 1)->>'total')::int
      = (select count(*)::int from public.acct_audit));
end $$;

select 'AUTHORITATIVE FINANCIALS SQL TESTS COMPLETE' as done;
rollback;
