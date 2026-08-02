-- ============================================================
-- Larsa Control — Accounting upgrade, part 8:
-- ONE authoritative financial model.
--
-- Corrects the deployed construction accounting model. Client
-- construction funding is money HELD AND MANAGED FOR THE PROJECT.
-- It is not Larsa company revenue, and company profit is never
-- "client funding minus construction spending".
--
--   Larsa Revenue      = earned consultancy fees
--                      + engineering revenue
--                      + other Larsa revenue
--   Company Net Profit = Larsa Revenue − Larsa company expenses
--
-- Materials and labour paid out of client-controlled project funds
-- are CLIENT FUND movements. They never become Larsa company
-- expenses automatically. A project that genuinely runs on
-- contractor/principal accounting must say so explicitly through
-- acct_projects.accounting_mode = 'contractor'; the two models are
-- never silently mixed.
--
-- Currency: raw USD and IQD are never added. Every figure is
-- returned three ways —
--   *_iqd / *_usd : reporting-currency totals, each entry converted
--                   at ITS OWN permanent historical snapshot rate
--                   (changing the platform default never moves them)
--   by_currency   : untouched original-currency totals, kept apart
-- Exchange rates are never summed anywhere.
--
-- Approval: every active saved entry is in the WORKING totals
-- immediately. Approval changes reliability, never the amount.
-- APPROVED totals contain only approved/posted/received/paid
-- entries. Rejected, void, reversed, and deleted entries count in
-- neither.
--
-- Reversible: drop the functions added here and the earlier
-- acct_project_summary / acct_project_summary_v2 keep working
-- unchanged (they are retained and now delegate).
-- ============================================================

-- Explicit per-project accounting model. Default preserves the
-- current, correct client-funded execution model for every project.
alter table public.acct_projects
  add column if not exists accounting_mode text not null default 'client_funded'
    check (accounting_mode in ('client_funded','contractor'));

comment on column public.acct_projects.accounting_mode is
  'client_funded (default): client funding is held in trust for the project and is NOT Larsa revenue; Larsa earns only the consultancy fee. contractor: Larsa is principal — funding is company revenue and project costs are company costs. Never mixed implicitly.';

-- ------------------------------------------------------------
-- Who bears a cost? Client-controlled project funds by default.
-- A cost only becomes a Larsa company expense when it explicitly
-- says so, so client-fund spending can never silently inflate or
-- deflate company profit.
-- ------------------------------------------------------------
create or replace function public.acct_cost_bearer(p_payment_source text, p_meta jsonb)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when lower(coalesce(p_meta->>'cost_bearer','')) in ('larsa','company') then 'larsa'
    when lower(coalesce(p_meta->>'cost_bearer','')) = 'client' then 'client'
    when lower(coalesce(p_payment_source,'')) in
      ('larsa','larsa operating','larsa funds','company','company funds','company account',
       'larsa account','operating','overhead','larsa overhead') then 'larsa'
    else 'client'
  end;
$$;

-- Entries that are live but NOT yet counted as approved.
create or replace function public.acct_unapproved_statuses()
returns text[]
language sql immutable
as $$ select array['draft','pending'] $$;

-- ------------------------------------------------------------
-- THE authoritative project financial summary.
-- Every accounting surface reads this and only this: project
-- summary, project cards, Construction Financials, Client View,
-- Client Statement, Funding Statement, dashboard, charts,
-- receipts, and CSV / Excel / PDF exports.
-- ------------------------------------------------------------
create or replace function public.acct_project_financials(p_project_id text)
returns jsonb
language plpgsql
stable
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  ps record;
  r record;
  mode text;

  -- client fund control, approved basis
  a_gross_iqd numeric := 0; a_gross_usd numeric := 0;
  a_mat_iqd numeric := 0;   a_mat_usd numeric := 0;
  a_lab_iqd numeric := 0;   a_lab_usd numeric := 0;
  a_oth_iqd numeric := 0;   a_oth_usd numeric := 0;
  -- working basis (approved + unapproved-but-live)
  w_gross_iqd numeric := 0; w_gross_usd numeric := 0;
  w_mat_iqd numeric := 0;   w_mat_usd numeric := 0;
  w_lab_iqd numeric := 0;   w_lab_usd numeric := 0;
  w_oth_iqd numeric := 0;   w_oth_usd numeric := 0;
  -- Larsa-borne project costs (excluded from client fund control)
  l_cost_iqd numeric := 0;  l_cost_usd numeric := 0;
  lw_cost_iqd numeric := 0; lw_cost_usd numeric := 0;
  -- company revenue
  eng_iqd numeric := 0;     eng_usd numeric := 0;
  oth_rev_iqd numeric := 0; oth_rev_usd numeric := 0;
  -- fees
  fee_all_iqd numeric := 0;   fee_all_usd numeric := 0;
  fee_deduct_iqd numeric := 0;fee_deduct_usd numeric := 0;
  fee_expense_iqd numeric := 0;
  fee_revenue_iqd numeric := 0;
  fee_estimated_iqd numeric := 0;
  fee_reversed_iqd numeric := 0;
  fee_refunded_iqd numeric := 0;
  refunded_principal_iqd numeric := 0;
  adj_iqd numeric := 0;
  settled_count int := 0;

  by_cur jsonb := '{}'::jsonb;
  cur_row record;

  -- derived
  a_cost_iqd numeric; a_cost_usd numeric;
  w_cost_iqd numeric; w_cost_usd numeric;
  p_cost_iqd numeric; p_cost_usd numeric;
  a_net_iqd numeric;  a_net_usd numeric;
  a_used_iqd numeric; a_used_usd numeric;
  w_used_iqd numeric; w_used_usd numeric;
  a_remain_iqd numeric; a_remain_usd numeric;
  w_remain_iqd numeric; w_remain_usd numeric;

  larsa_rev_iqd numeric; larsa_rev_usd numeric;
  co_exp_iqd numeric;    co_exp_usd numeric;
  co_net_iqd numeric;    co_net_usd numeric;

  refund_calc jsonb;
  fee_rule jsonb;
  latest_progress record;
  cost_progress numeric;
  cost_in_budget_cur numeric;
  budget numeric; budget_cur text;
  unapproved_count int := 0;
  unapproved_iqd numeric := 0;
  needs_correction_count int := 0;
  agg_status text;
begin
  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_SUMMARY: unknown project "%"', p_project_id; end if;
  select * into ps from public.acct_platform_settings where id = 1;
  mode := coalesce(proj.accounting_mode, 'client_funded');

  -- ---------- one pass over the ledger ----------
  for r in
    select t.kind, t.status, t.review_status, t.amount_iqd, t.amount_usd,
           t.original_amount, t.original_currency, t.payment_source, t.meta,
           public.acct_cost_bearer(t.payment_source, t.meta) as bearer,
           (t.status = any (public.acct_actual_statuses(t.kind))) as is_approved,
           (t.status = any (public.acct_unapproved_statuses())) as is_open
      from public.acct_transactions t
     where t.project_id = proj.id
       and t.deleted_at is null
       and t.status not in ('void','reversed','rejected')
  loop
    -- Working basis = approved + still-open. Nothing else is live.
    if not (r.is_approved or r.is_open) then continue; end if;

    if r.is_open then
      unapproved_count := unapproved_count + 1;
      unapproved_iqd := unapproved_iqd + coalesce(r.amount_iqd,0);
    end if;
    if r.review_status = 'needs_correction' then
      needs_correction_count := needs_correction_count + 1;
    end if;

    if r.kind = 'funding' then
      if r.is_approved then
        a_gross_iqd := a_gross_iqd + coalesce(r.amount_iqd,0);
        a_gross_usd := a_gross_usd + coalesce(r.amount_usd,0);
      end if;
      w_gross_iqd := w_gross_iqd + coalesce(r.amount_iqd,0);
      w_gross_usd := w_gross_usd + coalesce(r.amount_usd,0);

    elsif r.kind = 'revenue' then
      if r.is_approved then
        eng_iqd := eng_iqd + coalesce(r.amount_iqd,0);
        eng_usd := eng_usd + coalesce(r.amount_usd,0);
      end if;

    elsif r.kind in ('material','labor','expense') then
      if r.bearer = 'larsa' then
        -- Larsa's own money: a company expense, never a client-fund movement.
        if r.is_approved then
          l_cost_iqd := l_cost_iqd + coalesce(r.amount_iqd,0);
          l_cost_usd := l_cost_usd + coalesce(r.amount_usd,0);
        end if;
        lw_cost_iqd := lw_cost_iqd + coalesce(r.amount_iqd,0);
        lw_cost_usd := lw_cost_usd + coalesce(r.amount_usd,0);
      else
        if r.kind = 'material' then
          if r.is_approved then
            a_mat_iqd := a_mat_iqd + coalesce(r.amount_iqd,0);
            a_mat_usd := a_mat_usd + coalesce(r.amount_usd,0);
          end if;
          w_mat_iqd := w_mat_iqd + coalesce(r.amount_iqd,0);
          w_mat_usd := w_mat_usd + coalesce(r.amount_usd,0);
        elsif r.kind = 'labor' then
          if r.is_approved then
            a_lab_iqd := a_lab_iqd + coalesce(r.amount_iqd,0);
            a_lab_usd := a_lab_usd + coalesce(r.amount_usd,0);
          end if;
          w_lab_iqd := w_lab_iqd + coalesce(r.amount_iqd,0);
          w_lab_usd := w_lab_usd + coalesce(r.amount_usd,0);
        else
          if r.is_approved then
            a_oth_iqd := a_oth_iqd + coalesce(r.amount_iqd,0);
            a_oth_usd := a_oth_usd + coalesce(r.amount_usd,0);
          end if;
          w_oth_iqd := w_oth_iqd + coalesce(r.amount_iqd,0);
          w_oth_usd := w_oth_usd + coalesce(r.amount_usd,0);
        end if;
      end if;
    end if;
  end loop;

  -- Original-currency totals, kept strictly apart (never added).
  for cur_row in
    select t.original_currency as cur,
           sum(case when t.kind = 'funding' and t.status = any (public.acct_actual_statuses('funding'))
                    then t.original_amount else 0 end) as gross_approved,
           sum(case when t.kind = 'funding' then t.original_amount else 0 end) as gross_working,
           sum(case when t.kind in ('material','labor','expense')
                     and t.status = any (public.acct_actual_statuses('expense'))
                    then t.original_amount else 0 end) as cost_approved,
           sum(case when t.kind in ('material','labor','expense') then t.original_amount else 0 end) as cost_working,
           count(*) as entries
      from public.acct_transactions t
     where t.project_id = proj.id and t.deleted_at is null
       and t.status not in ('void','reversed','rejected')
       and (t.status = any (public.acct_actual_statuses(t.kind))
            or t.status = any (public.acct_unapproved_statuses()))
     group by t.original_currency
  loop
    by_cur := by_cur || jsonb_build_object(cur_row.cur, jsonb_build_object(
      'currency', cur_row.cur,
      'gross_funding_approved', round(cur_row.gross_approved,2),
      'gross_funding_working', round(cur_row.gross_working,2),
      'construction_cost_approved', round(cur_row.cost_approved,2),
      'construction_cost_working', round(cur_row.cost_working,2),
      'entries', cur_row.entries));
  end loop;

  -- ---------- consultancy fee ledger ----------
  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_all_iqd, fee_all_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled');
  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_deduct_iqd, fee_deduct_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'deduct_from_funding';
  select coalesce(sum(fee_iqd),0) into fee_expense_iqd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'project_expense';
  select coalesce(sum(fee_iqd),0) into fee_revenue_iqd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'larsa_revenue';
  select coalesce(sum(fee_iqd),0) into fee_estimated_iqd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status = 'estimated';
  select coalesce(-sum(fee_iqd),0) into fee_reversed_iqd
    from public.acct_fee_ledger where project_id = proj.id and entry_type in ('fee_reversal','fee_adjustment')
     and status in ('posted','settled');
  select count(*) into settled_count
    from public.acct_refund_settlements where project_id = proj.id and status = 'executed';

  select coalesce(sum((coalesce(meta->>'principal_iqd', amount_iqd::text))::numeric),0),
         coalesce(sum((coalesce(meta->>'fee_iqd','0'))::numeric),0)
    into refunded_principal_iqd, fee_refunded_iqd
    from public.acct_transactions where project_id = proj.id and kind = 'refund'
     and status in ('posted','paid') and deleted_at is null;
  if fee_refunded_iqd = 0 then fee_refunded_iqd := fee_reversed_iqd; end if;

  select coalesce(sum(amount_iqd),0) into adj_iqd
    from public.acct_transactions where project_id = proj.id and kind = 'adjustment'
     and status = 'posted' and deleted_at is null;

  -- ---------- client fund control ----------
  a_cost_iqd := a_mat_iqd + a_lab_iqd + a_oth_iqd;
  a_cost_usd := a_mat_usd + a_lab_usd + a_oth_usd;
  w_cost_iqd := w_mat_iqd + w_lab_iqd + w_oth_iqd;
  w_cost_usd := w_mat_usd + w_lab_usd + w_oth_usd;
  p_cost_iqd := w_cost_iqd - a_cost_iqd;
  p_cost_usd := w_cost_usd - a_cost_usd;

  a_net_iqd := a_gross_iqd - fee_deduct_iqd;
  a_net_usd := a_gross_usd - fee_deduct_usd;

  -- Total used against client funds = construction cost + any fee
  -- charged to the project (deducted from funding or booked as a
  -- project expense). A fee treated as separate Larsa revenue is not
  -- a project cost and is never double-counted here.
  a_used_iqd := a_cost_iqd + fee_deduct_iqd + fee_expense_iqd;
  a_used_usd := a_cost_usd + fee_deduct_usd;
  w_used_iqd := w_cost_iqd + fee_deduct_iqd + fee_expense_iqd;
  w_used_usd := w_cost_usd + fee_deduct_usd;

  a_remain_iqd := a_net_iqd - a_cost_iqd - fee_expense_iqd - refunded_principal_iqd + adj_iqd;
  a_remain_usd := a_net_usd - a_cost_usd;
  w_remain_iqd := a_net_iqd - w_cost_iqd - fee_expense_iqd - refunded_principal_iqd + adj_iqd;
  w_remain_usd := a_net_usd - w_cost_usd;

  -- ---------- Larsa company accounting ----------
  -- The consultancy fee is what the project earns Larsa, regardless of
  -- how it is settled against client funds. Client funding itself is
  -- NEVER revenue in the client-funded model.
  if mode = 'contractor' then
    larsa_rev_iqd := a_gross_iqd + eng_iqd + oth_rev_iqd;
    larsa_rev_usd := a_gross_usd + eng_usd + oth_rev_usd;
    co_exp_iqd := a_cost_iqd + l_cost_iqd;
    co_exp_usd := a_cost_usd + l_cost_usd;
  else
    larsa_rev_iqd := fee_all_iqd + eng_iqd + oth_rev_iqd;
    larsa_rev_usd := fee_all_usd + eng_usd + oth_rev_usd;
    co_exp_iqd := l_cost_iqd;
    co_exp_usd := l_cost_usd;
  end if;
  co_net_iqd := larsa_rev_iqd - co_exp_iqd - fee_refunded_iqd;
  co_net_usd := larsa_rev_usd - co_exp_usd;

  -- ---------- refund lifecycle ----------
  refund_calc := public.acct_compute_refund(proj.id, null, null);

  fee_rule := public.acct_resolve_fee_rule(proj.id, 'funding', null, null);

  select * into latest_progress from public.acct_progress_updates
   where project_id = proj.id order by update_date desc, created_at desc limit 1;

  budget := proj.approved_budget;
  budget_cur := coalesce(proj.budget_currency, proj.currency);
  if budget is not null and budget > 0 then
    cost_in_budget_cur := case when budget_cur = 'IQD' then a_cost_iqd else a_cost_usd end;
    cost_progress := round(cost_in_budget_cur / budget * 100, 1);
  end if;

  agg_status := case
    when needs_correction_count > 0 then 'red'
    when unapproved_count > 0 then 'yellow'
    else 'green' end;

  return jsonb_build_object(
    'project_id', proj.id,
    'project_name', proj.name,
    'project_code', proj.code,
    'client', proj.client,
    'region', proj.region,
    'currency', proj.currency,
    'accounting_mode', mode,
    'is_sample', proj.is_sample,
    'contract_value', proj.contract_value,
    'approved_budget', budget,
    'budget_currency', budget_cur,

    -- ======== CLIENT FUND CONTROL (held for the project) ========
    'client_funds', jsonb_build_object(
      'basis_note', 'Client construction funding is held and managed for the project. It is not Larsa company revenue.',
      'approved', jsonb_build_object(
        'gross_funding_iqd', round(a_gross_iqd,2),   'gross_funding_usd', round(a_gross_usd,2),
        'initial_fee_iqd', round(fee_deduct_iqd,2),  'initial_fee_usd', round(fee_deduct_usd,2),
        'net_construction_funding_iqd', round(a_net_iqd,2),
        'net_construction_funding_usd', round(a_net_usd,2),
        'materials_iqd', round(a_mat_iqd,2), 'materials_usd', round(a_mat_usd,2),
        'labor_iqd', round(a_lab_iqd,2),     'labor_usd', round(a_lab_usd,2),
        'other_costs_iqd', round(a_oth_iqd,2), 'other_costs_usd', round(a_oth_usd,2),
        'construction_cost_iqd', round(a_cost_iqd,2), 'construction_cost_usd', round(a_cost_usd,2),
        'total_used_iqd', round(a_used_iqd,2), 'total_used_usd', round(a_used_usd,2),
        'remaining_balance_iqd', round(a_remain_iqd,2),
        'remaining_balance_usd', round(a_remain_usd,2)),
      'working', jsonb_build_object(
        'gross_funding_iqd', round(w_gross_iqd,2),   'gross_funding_usd', round(w_gross_usd,2),
        'materials_iqd', round(w_mat_iqd,2), 'materials_usd', round(w_mat_usd,2),
        'labor_iqd', round(w_lab_iqd,2),     'labor_usd', round(w_lab_usd,2),
        'other_costs_iqd', round(w_oth_iqd,2), 'other_costs_usd', round(w_oth_usd,2),
        'construction_cost_iqd', round(w_cost_iqd,2), 'construction_cost_usd', round(w_cost_usd,2),
        'total_used_iqd', round(w_used_iqd,2), 'total_used_usd', round(w_used_usd,2),
        'remaining_balance_iqd', round(w_remain_iqd,2),
        'remaining_balance_usd', round(w_remain_usd,2)),
      'pending', jsonb_build_object(
        'construction_cost_iqd', round(p_cost_iqd,2),
        'construction_cost_usd', round(p_cost_usd,2),
        'gross_funding_iqd', round(w_gross_iqd - a_gross_iqd,2),
        'entries', unapproved_count),
      'refunded_principal_to_date_iqd', round(refunded_principal_iqd,2),
      'refundable_principal_iqd', refund_calc->'unused_net_funding_iqd',
      'refundable_fee_iqd', refund_calc->'refundable_fee_iqd',
      'total_refund_due_iqd', refund_calc->'total_refund_iqd',
      'adjustments_iqd', round(adj_iqd,2)),

    -- ======== LARSA COMPANY ACCOUNTING (what Larsa earns) ========
    'company', jsonb_build_object(
      'basis_note', case when mode = 'contractor'
        then 'Contractor mode: this project is run on principal accounting — funding is company revenue and project costs are company costs.'
        else 'Larsa Revenue = earned consultancy fees + engineering revenue + other Larsa revenue. Client funding and client-funded construction spending are excluded.' end,
      'consultancy_fee_revenue_iqd', round(case when mode = 'contractor' then 0 else fee_all_iqd end,2),
      'consultancy_fee_revenue_usd', round(case when mode = 'contractor' then 0 else fee_all_usd end,2),
      'engineering_revenue_iqd', round(eng_iqd,2), 'engineering_revenue_usd', round(eng_usd,2),
      'other_revenue_iqd', round(oth_rev_iqd,2),   'other_revenue_usd', round(oth_rev_usd,2),
      'client_funding_recognised_iqd', round(case when mode = 'contractor' then a_gross_iqd else 0 end,2),
      'larsa_revenue_iqd', round(larsa_rev_iqd,2), 'larsa_revenue_usd', round(larsa_rev_usd,2),
      'operating_expenses_iqd', round(l_cost_iqd,2), 'operating_expenses_usd', round(l_cost_usd,2),
      'larsa_attributable_project_costs_iqd', round(l_cost_iqd,2),
      'larsa_attributable_project_costs_working_iqd', round(lw_cost_iqd,2),
      'company_expenses_iqd', round(co_exp_iqd,2), 'company_expenses_usd', round(co_exp_usd,2),
      'fee_refunds_reversals_iqd', round(fee_refunded_iqd,2),
      'company_net_profit_iqd', round(co_net_iqd,2),
      'company_net_profit_usd', round(co_net_usd,2)),

    -- ======== CONSULTANCY FEE LIFECYCLE ========
    'fee', jsonb_build_object(
      'effective_rate', (fee_rule->>'rate')::numeric,
      'effective_rate_pct', round(coalesce((fee_rule->>'rate')::numeric,0) * 100, 4),
      'method', fee_rule->>'method',
      'source', fee_rule->>'source',
      'basis', fee_rule->>'basis',
      'treatment', fee_rule->>'treatment',
      'waived', coalesce((fee_rule->>'waived')::boolean, false),
      'initial_accrued_iqd', round(fee_all_iqd,2),
      'initial_accrued_usd', round(fee_all_usd,2),
      'deducted_from_funding_iqd', round(fee_deduct_iqd,2),
      'as_project_expense_iqd', round(fee_expense_iqd,2),
      'as_larsa_revenue_iqd', round(fee_revenue_iqd,2),
      'reversed_iqd', round(fee_reversed_iqd,2),
      'estimated_only_iqd', round(fee_estimated_iqd,2),
      'estimated_refundable_iqd', refund_calc->'refundable_fee_iqd',
      'refunded_to_date_iqd', round(fee_refunded_iqd,2),
      'current_recognised_iqd', round(fee_all_iqd - fee_refunded_iqd,2),
      'projected_after_full_refund_iqd', refund_calc->'retained_fee_iqd',
      'final_settled_iqd', case when settled_count > 0
        then to_jsonb(round(fee_all_iqd - fee_refunded_iqd,2)) else 'null'::jsonb end,
      'is_final', settled_count > 0,
      'settlements_executed', settled_count),

    -- ======== ORIGINAL-CURRENCY TOTALS (never added together) ========
    'by_currency', by_cur,
    'currencies_present', (select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(by_cur) k),

    -- ======== RELIABILITY ========
    'review', jsonb_build_object(
      'status', agg_status,
      'unapproved_entries', unapproved_count,
      'unapproved_amount_iqd', round(unapproved_iqd,2),
      'needs_correction_entries', needs_correction_count,
      'label', case
        when needs_correction_count > 0 then
          'Contains ' || needs_correction_count || ' entr' || case when needs_correction_count = 1 then 'y' else 'ies' end || ' needing correction'
        when unapproved_count > 0 then
          'Contains ' || unapproved_count || ' unapproved entr' || case when unapproved_count = 1 then 'y' else 'ies' end
        else 'All entries approved' end),

    'cost_progress_pct', cost_progress,
    'schedule_progress_pct', latest_progress.percent,
    'schedule_progress_date', latest_progress.update_date,
    'schedule_progress_by', latest_progress.updated_by_name,
    'computed_at', now());
end;
$$;

-- ------------------------------------------------------------
-- Company / portfolio rollup over the same authoritative model.
-- Adding across projects only ever adds like for like: the IQD
-- historical-equivalent column with the IQD column, USD with USD.
-- ------------------------------------------------------------
create or replace function public.acct_company_financials(
  p_project_ids jsonb default null,
  p_region text default null)
returns jsonb
language plpgsql
stable
security definer set search_path = public, pg_temp
as $$
declare
  pid text;
  one jsonb;
  rows jsonb := '[]'::jsonb;
  n int := 0;
  -- client funds
  c_gross numeric := 0; c_fee numeric := 0; c_net numeric := 0;
  c_cost_a numeric := 0; c_cost_w numeric := 0; c_pending numeric := 0;
  c_remain_a numeric := 0; c_remain_w numeric := 0;
  c_mat numeric := 0; c_lab numeric := 0; c_oth numeric := 0;
  c_refund_due numeric := 0;
  -- company
  k_fee numeric := 0; k_eng numeric := 0; k_other numeric := 0;
  k_rev numeric := 0; k_exp numeric := 0; k_refund numeric := 0; k_net numeric := 0;
  -- usd side
  u_gross numeric := 0; u_cost_a numeric := 0; u_rev numeric := 0; u_net numeric := 0;
  unapproved int := 0; needs_corr int := 0;
  by_cur jsonb := '{}'::jsonb;
  cur_row record;
  agg text;
begin
  for pid in
    select p.id from public.acct_projects p
     where p.archived_at is null
       and (p_project_ids is null or jsonb_array_length(p_project_ids) = 0
            or p.id in (select jsonb_array_elements_text(p_project_ids)))
       and (p_region is null or p_region = '' or lower(p.region) = lower(p_region))
     order by p.created_at
  loop
    one := public.acct_project_financials(pid);
    n := n + 1;
    c_gross := c_gross + (one#>>'{client_funds,approved,gross_funding_iqd}')::numeric;
    c_fee   := c_fee   + (one#>>'{client_funds,approved,initial_fee_iqd}')::numeric;
    c_net   := c_net   + (one#>>'{client_funds,approved,net_construction_funding_iqd}')::numeric;
    c_mat   := c_mat   + (one#>>'{client_funds,approved,materials_iqd}')::numeric;
    c_lab   := c_lab   + (one#>>'{client_funds,approved,labor_iqd}')::numeric;
    c_oth   := c_oth   + (one#>>'{client_funds,approved,other_costs_iqd}')::numeric;
    c_cost_a := c_cost_a + (one#>>'{client_funds,approved,construction_cost_iqd}')::numeric;
    c_cost_w := c_cost_w + (one#>>'{client_funds,working,construction_cost_iqd}')::numeric;
    c_pending := c_pending + (one#>>'{client_funds,pending,construction_cost_iqd}')::numeric;
    c_remain_a := c_remain_a + (one#>>'{client_funds,approved,remaining_balance_iqd}')::numeric;
    c_remain_w := c_remain_w + (one#>>'{client_funds,working,remaining_balance_iqd}')::numeric;
    c_refund_due := c_refund_due + coalesce((one#>>'{client_funds,total_refund_due_iqd}')::numeric,0);

    k_fee   := k_fee   + (one#>>'{company,consultancy_fee_revenue_iqd}')::numeric;
    k_eng   := k_eng   + (one#>>'{company,engineering_revenue_iqd}')::numeric;
    k_other := k_other + (one#>>'{company,other_revenue_iqd}')::numeric;
    k_rev   := k_rev   + (one#>>'{company,larsa_revenue_iqd}')::numeric;
    k_exp   := k_exp   + (one#>>'{company,company_expenses_iqd}')::numeric;
    k_refund := k_refund + (one#>>'{company,fee_refunds_reversals_iqd}')::numeric;
    k_net   := k_net   + (one#>>'{company,company_net_profit_iqd}')::numeric;

    u_gross := u_gross + (one#>>'{client_funds,approved,gross_funding_usd}')::numeric;
    u_cost_a := u_cost_a + (one#>>'{client_funds,approved,construction_cost_usd}')::numeric;
    u_rev := u_rev + (one#>>'{company,larsa_revenue_usd}')::numeric;
    u_net := u_net + (one#>>'{company,company_net_profit_usd}')::numeric;

    unapproved := unapproved + (one#>>'{review,unapproved_entries}')::int;
    needs_corr := needs_corr + (one#>>'{review,needs_correction_entries}')::int;

    -- Each row is a complete project view, so a caller that renders a
    -- project card or summary from the rollup shows exactly what the
    -- per-project function would have shown.
    rows := rows || jsonb_build_array(jsonb_build_object(
      'project_id', one->>'project_id',
      'project_name', one->>'project_name',
      'project_code', one->>'project_code',
      'client', one->>'client',
      'region', one->>'region',
      'currency', one->>'currency',
      'is_sample', one->'is_sample',
      'accounting_mode', one->>'accounting_mode',
      'contract_value', one->'contract_value',
      'approved_budget', one->'approved_budget',
      'budget_currency', one->>'budget_currency',
      'client_funds', one->'client_funds',
      'company', one->'company',
      'fee', one->'fee',
      'by_currency', one->'by_currency',
      'review', one->'review',
      'cost_progress_pct', one->'cost_progress_pct',
      'schedule_progress_pct', one->'schedule_progress_pct',
      'schedule_progress_date', one->'schedule_progress_date',
      'schedule_progress_by', one->'schedule_progress_by'));
  end loop;

  for cur_row in
    select t.original_currency as cur,
           sum(case when t.kind = 'funding' then t.original_amount else 0 end) as gross,
           sum(case when t.kind in ('material','labor','expense') then t.original_amount else 0 end) as cost,
           count(*) as entries
      from public.acct_transactions t
      join public.acct_projects p on p.id = t.project_id
     where t.deleted_at is null and t.status not in ('void','reversed','rejected')
       and p.archived_at is null
       and (p_project_ids is null or jsonb_array_length(p_project_ids) = 0
            or t.project_id in (select jsonb_array_elements_text(p_project_ids)))
       and (p_region is null or p_region = '' or lower(p.region) = lower(p_region))
     group by t.original_currency
  loop
    by_cur := by_cur || jsonb_build_object(cur_row.cur, jsonb_build_object(
      'currency', cur_row.cur,
      'gross_funding_working', round(cur_row.gross,2),
      'construction_cost_working', round(cur_row.cost,2),
      'entries', cur_row.entries));
  end loop;

  agg := case when needs_corr > 0 then 'red' when unapproved > 0 then 'yellow' else 'green' end;

  return jsonb_build_object(
    'projects', n,
    'region', p_region,
    'client_funds', jsonb_build_object(
      'basis_note', 'Client construction funds held and managed across projects. Not Larsa revenue.',
      'gross_funding_iqd', round(c_gross,2),
      'initial_fee_iqd', round(c_fee,2),
      'net_construction_funding_iqd', round(c_net,2),
      'materials_iqd', round(c_mat,2),
      'labor_iqd', round(c_lab,2),
      'other_costs_iqd', round(c_oth,2),
      'construction_cost_approved_iqd', round(c_cost_a,2),
      'construction_cost_working_iqd', round(c_cost_w,2),
      'pending_construction_cost_iqd', round(c_pending,2),
      'remaining_balance_approved_iqd', round(c_remain_a,2),
      'remaining_balance_working_iqd', round(c_remain_w,2),
      'total_refund_due_iqd', round(c_refund_due,2),
      'gross_funding_usd', round(u_gross,2),
      'construction_cost_approved_usd', round(u_cost_a,2)),
    'company', jsonb_build_object(
      'basis_note', 'Larsa Revenue = earned consultancy fees + engineering revenue + other Larsa revenue. Company Net Profit = Larsa Revenue − Larsa company expenses.',
      'consultancy_fee_revenue_iqd', round(k_fee,2),
      'engineering_revenue_iqd', round(k_eng,2),
      'other_revenue_iqd', round(k_other,2),
      'larsa_revenue_iqd', round(k_rev,2),
      'company_expenses_iqd', round(k_exp,2),
      'fee_refunds_reversals_iqd', round(k_refund,2),
      'company_net_profit_iqd', round(k_net,2),
      'net_margin_pct', case when k_rev > 0 then round(k_net / k_rev * 100, 1) else null end,
      'larsa_revenue_usd', round(u_rev,2),
      'company_net_profit_usd', round(u_net,2)),
    'by_currency', by_cur,
    'review', jsonb_build_object(
      'status', agg,
      'unapproved_entries', unapproved,
      'needs_correction_entries', needs_corr,
      'label', case
        when needs_corr > 0 then 'Contains ' || needs_corr || ' entr' || case when needs_corr = 1 then 'y' else 'ies' end || ' needing correction'
        when unapproved > 0 then 'Contains ' || unapproved || ' unapproved entr' || case when unapproved = 1 then 'y' else 'ies' end
        else 'All entries approved' end),
    'rows', rows,
    'computed_at', now());
end;
$$;

-- ------------------------------------------------------------
-- ONE calculation, everywhere. The long-standing project summary
-- keeps every key it has always returned, but every figure now
-- comes from acct_project_financials rather than a second copy of
-- the arithmetic. Two surfaces can no longer drift apart.
--
-- Behaviour change, deliberate: actual_construction_cost is now
-- strictly the CLIENT-FUND construction cost. A cost Larsa paid
-- from its own account is a company expense and is reported under
-- the company block instead of silently inflating project cost.
-- ------------------------------------------------------------
create or replace function public.acct_project_summary(p_project_id text)
returns jsonb
language sql
stable
security definer set search_path = public, pg_temp
as $$
  with f as (select public.acct_project_financials(p_project_id) as j)
  select jsonb_build_object(
    'project_id', j->>'project_id',
    'currency', j->>'currency',
    'contract_value', j->'contract_value',
    'approved_budget', j->'approved_budget',
    'budget_currency', j->>'budget_currency',
    'gross_funding_iqd', j#>'{client_funds,approved,gross_funding_iqd}',
    'gross_funding_usd', j#>'{client_funds,approved,gross_funding_usd}',
    'initial_fee_iqd', j#>'{fee,initial_accrued_iqd}',
    'initial_fee_usd', j#>'{fee,initial_accrued_usd}',
    'fee_deducted_from_funding_iqd', j#>'{fee,deducted_from_funding_iqd}',
    'fee_as_project_expense_iqd', j#>'{fee,as_project_expense_iqd}',
    'fee_as_larsa_revenue_iqd', j#>'{fee,as_larsa_revenue_iqd}',
    'fee_reversed_iqd', j#>'{fee,reversed_iqd}',
    'net_construction_funding_iqd', j#>'{client_funds,approved,net_construction_funding_iqd}',
    'net_construction_funding_usd', j#>'{client_funds,approved,net_construction_funding_usd}',
    'materials_iqd', j#>'{client_funds,approved,materials_iqd}',
    'materials_usd', j#>'{client_funds,approved,materials_usd}',
    'labor_iqd', j#>'{client_funds,approved,labor_iqd}',
    'labor_usd', j#>'{client_funds,approved,labor_usd}',
    'other_expenses_iqd', j#>'{client_funds,approved,other_costs_iqd}',
    'other_expenses_usd', j#>'{client_funds,approved,other_costs_usd}',
    'actual_construction_cost_iqd', j#>'{client_funds,approved,construction_cost_iqd}',
    'actual_construction_cost_usd', j#>'{client_funds,approved,construction_cost_usd}',
    'total_used_iqd', j#>'{client_funds,approved,total_used_iqd}',
    'total_used_usd', j#>'{client_funds,approved,total_used_usd}',
    'revenue_iqd', j#>'{company,engineering_revenue_iqd}',
    'revenue_usd', j#>'{company,engineering_revenue_usd}',
    'adjustments_iqd', j#>'{client_funds,adjustments_iqd}',
    'pending_commitments_iqd', j#>'{client_funds,pending,construction_cost_iqd}',
    'pending_commitments_usd', j#>'{client_funds,pending,construction_cost_usd}',
    'refunded_principal_iqd', j#>'{client_funds,refunded_principal_to_date_iqd}',
    'remaining_unused_iqd', j#>'{client_funds,refundable_principal_iqd}',
    'refundable_fee_iqd', j#>'{client_funds,refundable_fee_iqd}',
    'total_refund_due_iqd', j#>'{client_funds,total_refund_due_iqd}',
    'final_fee_retained_iqd', j#>'{fee,projected_after_full_refund_iqd}',
    -- Approved and working side by side: approval changes reliability,
    -- never the amount that was entered.
    'approved_actual_cost_iqd', j#>'{client_funds,approved,construction_cost_iqd}',
    'pending_actual_cost_iqd', j#>'{client_funds,pending,construction_cost_iqd}',
    'working_actual_cost_iqd', j#>'{client_funds,working,construction_cost_iqd}',
    'approved_remaining_balance_iqd', j#>'{client_funds,approved,remaining_balance_iqd}',
    'working_remaining_balance_iqd', j#>'{client_funds,working,remaining_balance_iqd}',
    'larsa_revenue_iqd', j#>'{company,larsa_revenue_iqd}',
    'company_net_profit_iqd', j#>'{company,company_net_profit_iqd}',
    'reliability_status', j#>'{review,status}',
    'reliability_label', j#>'{review,label}',
    'cost_progress_pct', j->'cost_progress_pct',
    'schedule_progress_pct', j->'schedule_progress_pct',
    'schedule_progress_date', j->'schedule_progress_date',
    'schedule_progress_by', j->'schedule_progress_by',
    'computed_at', j->'computed_at')
  from f;
$$;

-- ------------------------------------------------------------
-- Backward compatibility: v2 keeps its exact shape (existing
-- callers untouched) and gains the authoritative
-- approved/working split plus the two separated blocks.
-- ------------------------------------------------------------
create or replace function public.acct_project_summary_v2(p_project_id text)
returns jsonb
language sql
stable
security definer set search_path = public, pg_temp
as $$
  -- The per-kind review breakdown keeps the `review` key it has always
  -- had; the authoritative model's own status lands under `reliability`
  -- so no existing caller changes meaning.
  select public.acct_project_summary(p_project_id)
      || (public.acct_project_financials(p_project_id) - 'review')
      || jsonb_build_object(
           'reliability', public.acct_project_financials(p_project_id)->'review',
           'review', public.acct_review_breakdown(p_project_id));
$$;

-- ------------------------------------------------------------
-- THE Accounting Approval Queue.
-- Distinct from the severity/risk flag queue (acct_review_queue),
-- which keeps its own purpose under the name Flags / Risk Reviews.
-- One row per record awaiting an accounting decision, with the
-- single action that is actually outstanding for it.
-- ------------------------------------------------------------
create or replace function public.acct_approval_queue(
  p_project_id text default null,
  p_kind text default null,
  p_created_by text default null,
  p_approver text default null,
  p_min_age_days int default null,
  p_status text default null,
  p_limit int default 500)
returns jsonb
language sql
stable
security definer set search_path = public, pg_temp
as $$
  with entries as (
    select
      t.id,
      'transaction'::text        as queue_type,
      t.kind                     as record_kind,
      t.txn_no                   as reference,
      t.project_id,
      p.name                     as project_name,
      p.code                     as project_code,
      t.description,
      t.category,
      t.original_amount          as amount,
      t.original_currency        as currency,
      t.amount_iqd,
      t.amount_usd,
      t.txn_date,
      t.status                   as payment_status,
      t.review_status,
      t.created_by_email         as entered_by,
      t.created_by_name          as entered_by_name,
      t.created_at,
      -- Exactly ONE outstanding action per record: an entry that has
      -- never been counted needs approval; an already-counted entry
      -- only needs its review sign-off.
      case when t.status = any (public.acct_unapproved_statuses())
           then 'approve_entry' else 'review_entry' end as action,
      case when t.status = any (public.acct_unapproved_statuses())
           then 'Approve so it counts' else 'Review sign-off' end as action_label,
      coalesce(
        nullif((select string_agg(x, ', ') from jsonb_array_elements_text(p.assigned_approvers) x), ''),
        nullif((select string_agg(x, ', ') from jsonb_array_elements_text(
          coalesce((select area_approvers->t.kind from public.acct_platform_settings where id = 1), '[]'::jsonb)) x), ''),
        'Any authorised approver') as assigned_approver,
      (t.fee_rule->>'source' = 'transaction_override')      as has_fee_override,
      (t.rate_source = 'transaction_override')              as has_rate_override,
      extract(day from now() - t.created_at)::int           as age_days,
      t.is_sample
    from public.acct_transactions t
    join public.acct_projects p on p.id = t.project_id
   where t.deleted_at is null
     and t.status not in ('void','reversed','rejected')
     and (t.status = any (public.acct_unapproved_statuses())
          or t.review_status in ('unreviewed','pending_review','needs_correction'))
  ),
  refunds as (
    select
      s.id, 'refund'::text, 'refund'::text, 'REF-' || left(s.id::text, 8),
      s.project_id, p.name, p.code,
      'Refund settlement of unused client funds', 'refund',
      s.total_refund, p.currency, s.total_refund, null::numeric,
      s.created_at::date, s.status, 'pending_review',
      s.created_by, s.created_by, s.created_at,
      'approve_refund', 'Approve refund settlement',
      'Platform Super Admin', false, false,
      extract(day from now() - s.created_at)::int, s.is_sample
    from public.acct_refund_settlements s
    join public.acct_projects p on p.id = s.project_id
   where s.status in ('draft','pending')
  ),
  protected as (
    select
      a.id, 'protected'::text, a.action, 'APR-' || left(a.id::text, 8),
      a.project_id, coalesce(p.name,'(platform)'), p.code,
      a.reason, a.action,
      null::numeric, null::text, null::numeric, null::numeric,
      a.created_at::date, a.status, 'pending_review',
      a.requester_email, a.requester_name, a.created_at,
      'decide_protected', 'Platform Super Admin decision',
      'Platform Super Admin', false, false,
      extract(day from now() - a.created_at)::int, a.is_sample
    from public.acct_approval_requests a
    left join public.acct_projects p on p.id = a.project_id
   where a.status = 'pending'
  ),
  all_rows as (
    select * from entries
    union all select * from refunds
    union all select * from protected
  )
  select jsonb_build_object(
    'total', (select count(*) from all_rows),
    'by_kind', (select coalesce(jsonb_object_agg(record_kind, c),'{}'::jsonb)
                  from (select record_kind, count(*) c from all_rows group by record_kind) z),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.age_days desc, x.created_at)
        from (
          select * from all_rows r
           where (p_project_id is null or p_project_id = '' or r.project_id = p_project_id)
             and (p_kind is null or p_kind = '' or r.record_kind = p_kind)
             and (p_created_by is null or p_created_by = '' or lower(coalesce(r.entered_by,'')) = lower(p_created_by))
             and (p_approver is null or p_approver = '' or r.assigned_approver ilike '%' || p_approver || '%')
             and (p_min_age_days is null or r.age_days >= p_min_age_days)
             and (p_status is null or p_status = '' or r.payment_status = p_status)
           limit least(greatest(coalesce(p_limit,500),1),2000)) x),
      '[]'::jsonb),
    'computed_at', now());
$$;

-- ------------------------------------------------------------
-- Permanent accounting history, browsable: filters, free-text
-- search, and paging. Nothing is ever deleted or capped away —
-- the underlying table stays append-only and complete.
-- ------------------------------------------------------------
create or replace function public.acct_audit_page(
  p_project_id text default null,
  p_search text default null,
  p_action text default null,
  p_actor text default null,
  p_from date default null,
  p_to date default null,
  p_record_type text default null,
  p_before bigint default null,
  p_limit int default 100)
returns jsonb
language sql
stable
security definer set search_path = public, pg_temp
as $$
  with filtered as (
    select a.* from public.acct_audit a
     where (p_project_id is null or p_project_id = '' or a.project_id = p_project_id)
       and (p_action is null or p_action = '' or a.action ilike '%' || p_action || '%')
       and (p_actor is null or p_actor = '' or a.actor_email ilike '%' || p_actor || '%')
       and (p_record_type is null or p_record_type = '' or a.record_type = p_record_type)
       and (p_from is null or a.at >= p_from::timestamptz)
       and (p_to is null or a.at < (p_to + 1)::timestamptz)
       and (p_search is null or p_search = ''
            or a.action ilike '%' || p_search || '%'
            or coalesce(a.details,'') ilike '%' || p_search || '%'
            or coalesce(a.reason,'') ilike '%' || p_search || '%'
            or coalesce(a.actor_email,'') ilike '%' || p_search || '%'
            or coalesce(a.record_id,'') ilike '%' || p_search || '%'
            -- Search the recorded values too, so a description, supplier or
            -- reference number finds the event that carried it.
            or coalesce(a.after_data::text,'') ilike '%' || p_search || '%'
            or coalesce(a.before_data::text,'') ilike '%' || p_search || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'at', x.at,
               'actor_email', x.actor_email, 'actor_name', x.actor_name, 'actor_role', x.actor_role,
               'project_id', x.project_id, 'record_type', x.record_type, 'record_id', x.record_id,
               'action', x.action, 'reason', x.reason, 'approval_id', x.approval_id,
               'details', x.details,
               'before_data', x.before_data, 'after_data', x.after_data,
               'changed_fields', (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'field', k,
                          'before', x.before_data->k,
                          'after', x.after_data->k)), '[]'::jsonb)
                   from jsonb_object_keys(coalesce(x.after_data,'{}'::jsonb)) k
                  where x.before_data is not null
                    and x.before_data ? k
                    and (x.before_data->k) is distinct from (x.after_data->k)
                    and k not in ('updated_at','created_at')))
             order by x.id desc)
        from (select * from filtered
               where (p_before is null or id < p_before)
               order by id desc
               limit least(greatest(coalesce(p_limit,100),1),1000)) x),
      '[]'::jsonb),
    'actions', (select coalesce(jsonb_agg(distinct action order by action),'[]'::jsonb) from public.acct_audit),
    'computed_at', now());
$$;

do $$
begin
  revoke all on function public.acct_project_financials(text) from public, anon;
  grant execute on function public.acct_project_financials(text) to authenticated;
  revoke all on function public.acct_company_financials(jsonb,text) from public, anon;
  grant execute on function public.acct_company_financials(jsonb,text) to authenticated;
  revoke all on function public.acct_approval_queue(text,text,text,text,int,text,int) from public, anon;
  grant execute on function public.acct_approval_queue(text,text,text,text,int,text,int) to authenticated;
  revoke all on function public.acct_audit_page(text,text,text,text,date,date,text,bigint,int) from public, anon;
  grant execute on function public.acct_audit_page(text,text,text,text,date,date,text,bigint,int) to authenticated;
  revoke all on function public.acct_cost_bearer(text,jsonb) from public, anon;
  grant execute on function public.acct_cost_bearer(text,jsonb) to authenticated;
exception when others then null;
end $$;
