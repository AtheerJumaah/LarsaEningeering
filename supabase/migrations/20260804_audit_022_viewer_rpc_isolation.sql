-- ============================================================
-- Larsa Control — audit finding: a genuine Viewer identity (a real
-- Supabase Auth sign-in, `authenticated` role, recorded as auth_user_id
-- on viewer_accounts) can call the STAFF summary RPCs directly —
-- acct_project_summary, acct_project_summary_v2, acct_company_financials,
-- acct_funding_statement, acct_compute_refund — instead of the
-- Viewer-scoped viewer_project_summary. All five are granted to
-- `authenticated` (correctly — that is also every real employee session,
-- which signs in anonymously but still carries `authenticated`) and none
-- of the five checks who is actually asking; only viewer_project_summary
-- does, via viewer_section_enabled -> viewer_can_read_project. A Viewer
-- calling the unrestricted name directly instead of the scoped one gets
-- full, unscoped financials for any project by id, or company-wide —
-- client funding, consultancy fees, company profit — the exact thing
-- viewer_project_summary exists to prevent, and the exact rule stated for
-- this application: a Viewer's project scope must be enforced server-side,
-- never by which button the UI happens to show.
--
-- This is not the 20260803_acct_017 gap. That closed `anon`-with-no-
-- session access on three functions; both staff and Viewer sessions were
-- already `authenticated` either way, so it did not touch this. This
-- closes the separate case: an authenticated Viewer, calling the correct
-- role but the wrong, unscoped endpoint.
--
-- Fix: block at the two functions that read the ledger directly
-- (acct_project_financials, acct_compute_refund) and the one summary
-- function that does not route through either (acct_funding_statement).
-- acct_project_summary, acct_project_summary_v2, and
-- acct_company_financials all call acct_project_financials internally, so
-- blocking there closes all three without touching their own definitions
-- or any app call site. Keyed on auth.uid() against viewer_accounts,
-- which every real employee session leaves unmatched (staff identity is
-- self-asserted over an anonymous session, not a viewer_accounts row) —
-- nothing changes for staff, and nothing here touches Accounting's
-- structure, figures, or any Admin capability.
--
-- One wrinkle the first draft of this fix got wrong and this one does
-- not: viewer_project_summary — the legitimate, already-correctly-scoped
-- Viewer entry point — reaches the client's real financial figures by
-- calling acct_project_summary itself, which calls acct_project_financials.
-- A block with no exception for that call chain would fail the one path
-- it exists to protect, for every real Viewer, the moment this shipped.
-- The fix reuses acct_internal_op() — the same transaction-local flag
-- acct_post_transaction and acct_set_txn_status already use for this
-- exact shape of problem (an already-authorized internal flow that must
-- not be re-blocked by the check meant for direct outside callers).
-- viewer_project_summary sets it, immediately after its own
-- viewer_section_enabled check passes, for the rest of its own
-- transaction only; PostgREST gives every RPC call a fresh transaction,
-- so a direct external call to acct_project_summary starts with the flag
-- unset and is still blocked.
-- ============================================================

create or replace function public.acct_block_if_viewer()
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if public.acct_internal_op() then return; end if;
  if exists (select 1 from public.viewer_accounts where auth_user_id = auth.uid()) then
    raise exception 'ACCT_FORBIDDEN: viewer accounts must use the viewer-scoped summary endpoints';
  end if;
end;
$$;

revoke all on function public.acct_block_if_viewer() from public, anon;
grant execute on function public.acct_block_if_viewer() to authenticated;

create or replace function public.acct_project_financials(p_project_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  proj record;
  ps record;
  r record;
  mode text;
  a_gross_iqd numeric := 0; a_gross_usd numeric := 0;
  a_mat_iqd numeric := 0;   a_mat_usd numeric := 0;
  a_lab_iqd numeric := 0;   a_lab_usd numeric := 0;
  a_oth_iqd numeric := 0;   a_oth_usd numeric := 0;
  w_gross_iqd numeric := 0; w_gross_usd numeric := 0;
  w_mat_iqd numeric := 0;   w_mat_usd numeric := 0;
  w_lab_iqd numeric := 0;   w_lab_usd numeric := 0;
  w_oth_iqd numeric := 0;   w_oth_usd numeric := 0;
  l_cost_iqd numeric := 0;  l_cost_usd numeric := 0;
  lw_cost_iqd numeric := 0; lw_cost_usd numeric := 0;
  eng_iqd numeric := 0;     eng_usd numeric := 0;
  oth_rev_iqd numeric := 0; oth_rev_usd numeric := 0;
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
  perform public.acct_block_if_viewer();

  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_SUMMARY: unknown project "%"', p_project_id; end if;
  select * into ps from public.acct_platform_settings where id = 1;
  mode := coalesce(proj.accounting_mode, 'client_funded');

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

  a_cost_iqd := a_mat_iqd + a_lab_iqd + a_oth_iqd;
  a_cost_usd := a_mat_usd + a_lab_usd + a_oth_usd;
  w_cost_iqd := w_mat_iqd + w_lab_iqd + w_oth_iqd;
  w_cost_usd := w_mat_usd + w_lab_usd + w_oth_usd;
  p_cost_iqd := w_cost_iqd - a_cost_iqd;
  p_cost_usd := w_cost_usd - a_cost_usd;

  a_net_iqd := a_gross_iqd - fee_deduct_iqd;
  a_net_usd := a_gross_usd - fee_deduct_usd;

  a_used_iqd := a_cost_iqd + fee_deduct_iqd + fee_expense_iqd;
  a_used_usd := a_cost_usd + fee_deduct_usd;
  w_used_iqd := w_cost_iqd + fee_deduct_iqd + fee_expense_iqd;
  w_used_usd := w_cost_usd + fee_deduct_usd;

  a_remain_iqd := a_net_iqd - a_cost_iqd - fee_expense_iqd - refunded_principal_iqd + adj_iqd;
  a_remain_usd := a_net_usd - a_cost_usd;
  w_remain_iqd := a_net_iqd - w_cost_iqd - fee_expense_iqd - refunded_principal_iqd + adj_iqd;
  w_remain_usd := a_net_usd - w_cost_usd;

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
    'by_currency', by_cur,
    'currencies_present', (select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(by_cur) k),
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
$function$;

create or replace function public.acct_funding_statement(p_project_id text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  proj record; ps record;
  rows_j jsonb;
  totals record;
  refund_calc jsonb;
  pending_n int;
begin
  perform public.acct_block_if_viewer();

  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_STATEMENT: unknown project'; end if;
  select * into ps from public.acct_platform_settings where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'txn_no', t.txn_no,
      'receipt_no', coalesce(r.receipt_no, t.receipt_no),
      'date', t.txn_date,
      'payer', coalesce(t.meta->>'payerName', proj.client, ''),
      'currency', t.original_currency,
      'amount', t.original_amount,
      'exchange_rate', t.exchange_rate,
      'rate_source', t.rate_source,
      'amount_iqd', t.amount_iqd,
      'amount_usd', t.amount_usd,
      'fee_amount', coalesce(f.fee_amount, 0),
      'fee_currency', coalesce(f.currency, t.original_currency),
      'net_construction', case when coalesce(f.treatment, t.fee_rule->>'treatment') = 'deduct_from_funding'
                               then round(t.original_amount - coalesce(f.fee_amount,0),2) else t.original_amount end,
      'payment_status', t.status,
      'review_status', t.review_status,
      'method', coalesce(t.meta->>'method','')
    ) order by t.txn_date, t.created_at), '[]'::jsonb)
    into rows_j
    from public.acct_transactions t
    left join public.acct_receipts r on r.txn_id = t.id and r.kind = 'original' and r.voided_at is null
    left join public.acct_fee_ledger f on f.source_txn_id = t.id and f.entry_type = 'fee' and f.status in ('estimated','posted','settled')
   where t.project_id = proj.id and t.kind = 'funding'
     and t.status not in ('void','reversed','rejected') and t.deleted_at is null
     and (p_from is null or t.txn_date >= p_from)
     and (p_to is null or t.txn_date <= p_to);

  select
    coalesce(sum(t.amount_iqd),0) as funding_iqd,
    coalesce(sum(t.amount_usd),0) as funding_usd,
    coalesce(sum(t.amount_iqd) filter (where t.review_status = 'approved'),0) as approved_iqd,
    coalesce(sum(t.amount_iqd) filter (where t.review_status in ('unreviewed','pending_review')),0) as pending_iqd,
    coalesce(sum(t.amount_iqd) filter (where t.review_status = 'needs_correction'),0) as correction_iqd,
    count(*) filter (where t.review_status <> 'approved') as not_approved
    into totals
    from public.acct_transactions t
   where t.project_id = proj.id and t.kind = 'funding'
     and t.status not in ('void','reversed','rejected') and t.deleted_at is null
     and (p_from is null or t.txn_date >= p_from)
     and (p_to is null or t.txn_date <= p_to);

  refund_calc := public.acct_compute_refund(proj.id, null, null);
  pending_n := totals.not_approved;

  return jsonb_build_object(
    'company', 'Larsa Engineering',
    'project_id', proj.id, 'project_code', proj.code, 'project_name', proj.name,
    'client', proj.client, 'currency', proj.currency,
    'period_from', p_from, 'period_to', p_to,
    'entries', rows_j,
    'total_funding_iqd', totals.funding_iqd,
    'total_funding_usd', totals.funding_usd,
    'approved_funding_iqd', totals.approved_iqd,
    'pending_funding_iqd', totals.pending_iqd,
    'needs_correction_funding_iqd', totals.correction_iqd,
    'total_fee_iqd', refund_calc->'initial_fee_iqd',
    'total_net_funding_iqd', refund_calc->'net_construction_funding_iqd',
    'total_expenses_iqd', refund_calc->'approved_expenses_iqd',
    'remaining_balance_iqd', refund_calc->'unused_net_funding_iqd',
    'refundable_to_client_iqd', refund_calc->'total_refund_iqd',
    'contains_pending', pending_n > 0,
    'pending_label', case when pending_n > 0 then 'Contains Entries Pending Internal Approval' else null end,
    'timezone', coalesce(ps.display_timezone,'Asia/Baghdad'),
    'generated_at', now());
end;
$function$;

create or replace function public.acct_compute_refund(p_project_id text, p_refund_amount_iqd numeric DEFAULT NULL::numeric, p_manual_allocations jsonb DEFAULT NULL::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  proj record;
  f record;
  expenses_iqd numeric := 0;
  expenses_usd numeric := 0;
  gross_iqd numeric := 0;
  initial_fee_iqd numeric := 0;
  net_pool numeric := 0;
  remaining numeric := 0;
  alloc jsonb := '[]'::jsonb;
  want numeric;
  entry_unused_iqd numeric;
  take_iqd numeric;
  unused_total_iqd numeric := 0;
  refundable_fee_iqd numeric := 0;
  refundable_fee_usd numeric := 0;
  unused_total_usd numeric := 0;
  entry_cur text;
  entry_rate numeric;
  entry_fee_rate numeric;
  entry_unused_orig numeric;
  entry_refundable_orig numeric;
  fee_treatment text;
  earned_fee_iqd numeric := 0;
  collected_fee_iqd numeric := 0;
  excess_fee_iqd numeric := 0;
  funding_based boolean := true;
  already_refunded_iqd numeric := 0;
begin
  perform public.acct_block_if_viewer();

  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_REFUND: unknown project'; end if;

  -- Approved/Posted project expenses (materials + labor + other), historical snapshots.
  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0)
    into expenses_iqd, expenses_usd
    from public.acct_transactions
   where project_id = proj.id and kind in ('material','labor','expense')
     and status = any (public.acct_actual_statuses('expense'))
     and deleted_at is null;

  -- Fees charged as project expense also consume construction funding.
  select expenses_iqd + coalesce(sum(fl.fee_iqd),0) into expenses_iqd
    from public.acct_fee_ledger fl
   where fl.project_id = proj.id and fl.entry_type = 'fee'
     and fl.status in ('posted','settled') and fl.treatment = 'project_expense';

  -- Principal already refunded (posted refund transactions, principal part).
  select coalesce(sum((coalesce(meta->>'principal_iqd', amount_iqd::text))::numeric),0)
    into already_refunded_iqd
    from public.acct_transactions
   where project_id = proj.id and kind = 'refund' and status in ('posted','paid')
     and deleted_at is null;

  remaining := expenses_iqd + already_refunded_iqd;

  for f in
    select t.*, fl.id as fee_id, fl.fee_rate as fee_rate, fl.fee_iqd as fee_iqd, fl.fee_usd as fee_usd,
           fl.treatment as fee_treat, fl.calc_method as fee_method, fl.status as fee_status
      from public.acct_transactions t
      left join public.acct_fee_ledger fl
        on fl.source_txn_id = t.id and fl.entry_type = 'fee' and fl.status in ('posted','settled')
     where t.project_id = proj.id and t.kind = 'funding'
       and t.status = any (public.acct_actual_statuses('funding'))
       and t.deleted_at is null
     order by t.txn_date, t.created_at
  loop
    gross_iqd := gross_iqd + f.amount_iqd;
    fee_treatment := coalesce(f.fee_treat, coalesce(f.fee_rule->>'treatment','deduct_from_funding'));
    if coalesce(f.fee_rule->>'basis','funding') <> 'funding' then funding_based := false; end if;
    initial_fee_iqd := initial_fee_iqd + coalesce(f.fee_iqd, 0);

    entry_unused_iqd := f.amount_iqd - case when fee_treatment = 'deduct_from_funding' then coalesce(f.fee_iqd,0) else 0 end;
    net_pool := net_pool + entry_unused_iqd;

    take_iqd := least(entry_unused_iqd, remaining);
    entry_unused_iqd := entry_unused_iqd - take_iqd;
    remaining := remaining - take_iqd;

    if entry_unused_iqd <= 0 then continue; end if;

    entry_cur := f.original_currency;
    entry_rate := f.exchange_rate;
    entry_fee_rate := coalesce(f.fee_rate, coalesce((f.fee_rule->>'rate')::numeric, 0));
    if coalesce(f.fee_method,'percentage') <> 'percentage' then entry_fee_rate := 0; end if;

    alloc := alloc || jsonb_build_object(
      'funding_txn_id', f.id, 'txn_no', f.txn_no, 'txn_date', f.txn_date,
      'currency', entry_cur, 'exchange_rate', entry_rate,
      'fee_id', f.fee_id, 'fee_rate', entry_fee_rate, 'fee_treatment', fee_treatment,
      'available_unused_iqd', round(entry_unused_iqd, 2));
  end loop;

  unused_total_iqd := greatest(net_pool - expenses_iqd - already_refunded_iqd, 0);
  want := least(coalesce(p_refund_amount_iqd, unused_total_iqd), unused_total_iqd);

  declare
    out_alloc jsonb := '[]'::jsonb;
    a jsonb;
    m numeric;
    left_want numeric := want;
  begin
    for a in select * from jsonb_array_elements(alloc)
    loop
      if p_manual_allocations is not null and jsonb_array_length(p_manual_allocations) > 0 then
        select coalesce((x->>'allocated_unused_iqd')::numeric, 0) into m
          from jsonb_array_elements(p_manual_allocations) x
         where x->>'funding_txn_id' = a->>'funding_txn_id' limit 1;
        m := least(coalesce(m,0), (a->>'available_unused_iqd')::numeric);
      else
        m := least(left_want, (a->>'available_unused_iqd')::numeric);
      end if;
      if m is null or m <= 0 then continue; end if;
      left_want := left_want - m;

      entry_rate := (a->>'exchange_rate')::numeric;
      entry_cur := a->>'currency';
      entry_fee_rate := coalesce((a->>'fee_rate')::numeric, 0);
      entry_unused_orig := case when entry_cur = 'IQD' then round(m, 2) else round(m / entry_rate, 2) end;
      entry_refundable_orig := round(entry_unused_orig * entry_fee_rate, 2);

      refundable_fee_iqd := refundable_fee_iqd +
        case when entry_cur = 'IQD' then entry_refundable_orig else round(entry_refundable_orig * entry_rate, 2) end;
      refundable_fee_usd := refundable_fee_usd +
        case when entry_cur = 'USD' then entry_refundable_orig else round(entry_refundable_orig / entry_rate, 2) end;
      unused_total_usd := unused_total_usd +
        case when entry_cur = 'USD' then entry_unused_orig else round(entry_unused_orig / entry_rate, 2) end;

      out_alloc := out_alloc || (a || jsonb_build_object(
        'allocated_unused_iqd', round(m,2),
        'allocated_unused_original', entry_unused_orig,
        'refundable_fee_original', entry_refundable_orig,
        'refundable_fee_iqd', case when entry_cur = 'IQD' then entry_refundable_orig else round(entry_refundable_orig * entry_rate, 2) end));
    end loop;
    alloc := out_alloc;
  end;

  -- Expense-based projects: unspent funding earns no fee; any fee
  -- previously collected beyond what eligible approved expenses earn
  -- is owed back to the client on top of the unused principal.
  if not funding_based then
    select coalesce(sum(fee_iqd),0) into collected_fee_iqd
      from public.acct_fee_ledger
     where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled');
    select coalesce(sum(fee_iqd),0) into earned_fee_iqd
      from public.acct_fee_ledger fl
      join public.acct_transactions t on t.id = fl.source_txn_id
     where fl.project_id = proj.id and fl.entry_type = 'fee' and fl.status in ('posted','settled')
       and t.kind in ('material','labor','expense')
       and t.status = any (public.acct_actual_statuses('expense')) and t.deleted_at is null;
    excess_fee_iqd := greatest(collected_fee_iqd - earned_fee_iqd, 0);
  end if;

  return jsonb_build_object(
    'project_id', proj.id,
    'funding_based', funding_based,
    'gross_funding_iqd', round(gross_iqd,2),
    'initial_fee_iqd', round(initial_fee_iqd,2),
    'net_construction_funding_iqd', round(net_pool,2),
    'approved_expenses_iqd', round(expenses_iqd,2),
    'already_refunded_iqd', round(already_refunded_iqd,2),
    'unused_net_funding_iqd', round(unused_total_iqd,2),
    'refund_principal_iqd', round(want,2),
    'refundable_fee_iqd', round(refundable_fee_iqd + excess_fee_iqd,2),
    'refundable_fee_usd', round(refundable_fee_usd,2),
    'excess_fee_iqd', round(excess_fee_iqd,2),
    'total_refund_iqd', round(want + refundable_fee_iqd + excess_fee_iqd,2),
    'retained_fee_iqd', round(initial_fee_iqd - refundable_fee_iqd - excess_fee_iqd,2),
    'partial', (want < unused_total_iqd),
    'allocations', alloc,
    'allocation_method', case when p_manual_allocations is not null and jsonb_array_length(coalesce(p_manual_allocations,'[]'::jsonb)) > 0 then 'manual' else 'FIFO' end,
    'computed_at', now());
end;
$function$;

-- The one caller that is meant to reach the now-blocked functions: marks
-- its own transaction as an authorized internal call, only after its own
-- Viewer-scoping check has already passed, and only for the rest of this
-- one request.
create or replace function public.viewer_project_summary(p_project_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare full_summary jsonb;
begin
  if not public.viewer_section_enabled(auth.uid(), p_project_id, 'financials') then
    return null;
  end if;
  perform set_config('acct.internal_op', '1', true);
  select public.acct_project_summary(p_project_id) into full_summary;
  if full_summary is null then return null; end if;
  return jsonb_build_object(
    'project_id',                       full_summary->>'project_id',
    'currency',                         full_summary->>'currency',
    'contract_value',                   full_summary->'contract_value',
    'approved_budget',                  full_summary->'approved_budget',
    'budget_currency',                  full_summary->>'budget_currency',
    'gross_funding_iqd',                full_summary->'gross_funding_iqd',
    'gross_funding_usd',                full_summary->'gross_funding_usd',
    'net_construction_funding_iqd',     full_summary->'net_construction_funding_iqd',
    'net_construction_funding_usd',     full_summary->'net_construction_funding_usd',
    'materials_iqd',                    full_summary->'materials_iqd',
    'materials_usd',                    full_summary->'materials_usd',
    'labor_iqd',                        full_summary->'labor_iqd',
    'labor_usd',                        full_summary->'labor_usd',
    'other_expenses_iqd',               full_summary->'other_expenses_iqd',
    'other_expenses_usd',               full_summary->'other_expenses_usd',
    'actual_construction_cost_iqd',     full_summary->'actual_construction_cost_iqd',
    'actual_construction_cost_usd',     full_summary->'actual_construction_cost_usd',
    'total_used_iqd',                   full_summary->'total_used_iqd',
    'total_used_usd',                   full_summary->'total_used_usd',
    'approved_remaining_balance_iqd',   full_summary->'approved_remaining_balance_iqd',
    'refunded_principal_iqd',           full_summary->'refunded_principal_iqd',
    'remaining_unused_iqd',             full_summary->'remaining_unused_iqd',
    'total_refund_due_iqd',             full_summary->'total_refund_due_iqd',
    'cost_progress_pct',                full_summary->'cost_progress_pct',
    'schedule_progress_pct',            full_summary->'schedule_progress_pct',
    'schedule_progress_date',           full_summary->'schedule_progress_date',
    'computed_at',                      full_summary->'computed_at'
  );
end;
$function$;
