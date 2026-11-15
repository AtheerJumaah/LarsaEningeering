-- Keep principal and consultancy-fee refunds within their historical balances.
-- This migration replaces calculations only. It does not change posted records.

create or replace function public.acct_compute_refund(
  p_project_id text,
  p_refund_amount_iqd numeric default null,
  p_manual_allocations jsonb default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  f record;
  a jsonb;
  expenses_iqd numeric := 0;
  gross_iqd numeric := 0;
  initial_fee_iqd numeric := 0;
  net_pool numeric := 0;
  remaining numeric;
  want numeric;
  left_want numeric;
  entry_unused_iqd numeric;
  entry_unused_orig numeric;
  entry_refundable_orig numeric;
  entry_fee_iqd numeric;
  unused_total_iqd numeric;
  refundable_fee_iqd numeric := 0;
  refundable_fee_usd numeric := 0;
  fee_treatment text;
  fee_basis text;
  funding_based boolean := true;
  collected_fee_iqd numeric := 0;
  collected_fee_usd numeric := 0;
  excess_fee_iqd numeric := 0;
  excess_fee_usd numeric := 0;
  already_refunded_iqd numeric := 0;
  already_refunded_fee_iqd numeric := 0;
  already_refunded_excess_iqd numeric := 0;
  posted_allocations jsonb;
  slots jsonb := '[]'::jsonb;
  allocations jsonb := '[]'::jsonb;
  manual boolean;
  take_iqd numeric;
begin
  perform public.acct_block_if_viewer();

  if not exists (select 1 from public.acct_projects where id = p_project_id) then
    raise exception 'ACCT_REFUND: unknown project';
  end if;
  if p_refund_amount_iqd < 0 then
    raise exception 'ACCT_REFUND: refund principal must be non-negative';
  end if;
  if p_manual_allocations is not null and jsonb_typeof(p_manual_allocations) <> 'array' then
    raise exception 'ACCT_REFUND: manual allocations must be an array';
  end if;
  manual := coalesce(jsonb_array_length(p_manual_allocations),0) > 0;

  select coalesce(sum(amount_iqd),0) into expenses_iqd
    from public.acct_transactions
   where project_id = p_project_id and kind in ('material','labor','expense')
     and status = any (public.acct_actual_statuses('expense'))
     and public.acct_cost_bearer(payment_source, meta) = 'client'
     and deleted_at is null;

  select expenses_iqd + coalesce(sum(fl.fee_iqd),0) into expenses_iqd
    from public.acct_fee_ledger fl
    left join public.acct_transactions st on st.id = fl.source_txn_id
   where fl.project_id = p_project_id and fl.entry_type = 'fee'
     and fl.status in ('posted','settled') and fl.treatment = 'project_expense'
     and (st.id is null or public.acct_cost_bearer(st.payment_source, st.meta) = 'client');

  select coalesce(sum(coalesce((t.meta->>'principal_iqd')::numeric,t.amount_iqd)),0),
         coalesce(sum(coalesce((t.meta->>'fee_refund_iqd')::numeric,(t.meta->>'fee_iqd')::numeric,0)),0),
         coalesce(sum(greatest(coalesce((t.meta->>'fee_refund_iqd')::numeric,(t.meta->>'fee_iqd')::numeric,0)
                              - coalesce(rev.amount,0),0)),0)
    into already_refunded_iqd, already_refunded_fee_iqd, already_refunded_excess_iqd
    from public.acct_transactions t
    left join lateral (
      select -sum(fl.fee_iqd) as amount
        from public.acct_fee_ledger fl
       where fl.refund_settlement_id::text = t.meta->>'settlement_id'
         and fl.entry_type = 'fee_reversal' and fl.status in ('posted','settled')
    ) rev on true
   where t.project_id = p_project_id and t.kind = 'refund'
     and t.status in ('posted','paid') and t.deleted_at is null;

  -- Retain the original funding entry for each posted principal allocation.
  -- Refunds imported without an allocation still consume funding FIFO.
  select coalesce(jsonb_object_agg(funding_id, principal), '{}'::jsonb),
         expenses_iqd + greatest(already_refunded_iqd - coalesce(sum(principal),0),0)
    into posted_allocations, remaining
    from (
      select allocation->>'funding_txn_id' as funding_id,
             sum((allocation->>'allocated_unused_iqd')::numeric) as principal
        from public.acct_refund_settlements rs
        join public.acct_transactions rt on rt.id = rs.refund_txn_id
        cross join lateral jsonb_array_elements(rs.allocations) as entries(allocation)
        join public.acct_transactions ft on ft.id::text = allocation->>'funding_txn_id'
       where rs.project_id = p_project_id and rs.status = 'posted'
         and rt.status in ('posted','paid') and rt.deleted_at is null
         and ft.project_id = p_project_id and ft.kind = 'funding'
         and ft.status = any(public.acct_actual_statuses('funding')) and ft.deleted_at is null
       group by allocation->>'funding_txn_id'
    ) posted;

  for f in
    select t.*, fl.id as fee_id, fl.fee_rate, fl.fee_iqd, fl.fee_amount, fl.treatment,
           fl.calc_method, fl.calc_basis,
           coalesce(rev.amount,0) as fee_reversed_orig
      from public.acct_transactions t
      left join public.acct_fee_ledger fl
        on fl.source_txn_id = t.id and fl.entry_type = 'fee' and fl.status in ('posted','settled')
      left join lateral (
        select -sum(fr.fee_amount) as amount
          from public.acct_fee_ledger fr
         where fr.reversal_of = fl.id and fr.entry_type = 'fee_reversal'
           and fr.status in ('posted','settled')
      ) rev on true
     where t.project_id = p_project_id and t.kind = 'funding'
       and t.status = any (public.acct_actual_statuses('funding')) and t.deleted_at is null
     order by t.txn_date, t.created_at, t.id
  loop
    gross_iqd := gross_iqd + f.amount_iqd;
    fee_treatment := coalesce(f.treatment,f.fee_rule->>'treatment','deduct_from_funding');
    fee_basis := coalesce(f.calc_basis,f.fee_rule->>'basis','funding');
    funding_based := funding_based and fee_basis = 'funding';
    initial_fee_iqd := initial_fee_iqd + coalesce(f.fee_iqd,0);
    entry_unused_iqd := f.amount_iqd - case when fee_treatment = 'deduct_from_funding'
                                          then coalesce(f.fee_iqd,0) else 0 end;
    net_pool := net_pool + entry_unused_iqd;
    entry_unused_iqd := entry_unused_iqd - coalesce((posted_allocations->>(f.id::text))::numeric,0);

    take_iqd := least(entry_unused_iqd,remaining);
    entry_unused_iqd := entry_unused_iqd - take_iqd;
    remaining := remaining - take_iqd;
    if entry_unused_iqd <= 0 then continue; end if;

    slots := slots || jsonb_build_object(
      'funding_txn_id', f.id, 'txn_no', f.txn_no, 'txn_date', f.txn_date,
      'currency', f.original_currency, 'exchange_rate', f.exchange_rate,
      'fee_id', f.fee_id, 'fee_treatment', fee_treatment,
      'fee_rate', case when fee_basis = 'funding' and f.calc_method = 'percentage'
                       then coalesce(f.fee_rate,0) else 0 end,
      'available_unused_iqd', round(entry_unused_iqd,2),
      'available_fee_original', greatest(coalesce(f.fee_amount,0) - f.fee_reversed_orig,0));
  end loop;

  unused_total_iqd := greatest(net_pool - expenses_iqd - already_refunded_iqd,0);
  want := least(coalesce(round(p_refund_amount_iqd,2),unused_total_iqd),unused_total_iqd);
  left_want := want;

  for a in select * from jsonb_array_elements(slots)
  loop
    take_iqd := least(left_want,(a->>'available_unused_iqd')::numeric);
    if manual then
      select least(take_iqd,round((requested->>'allocated_unused_iqd')::numeric,2))
        into take_iqd
        from jsonb_array_elements(p_manual_allocations) as items(requested)
       where requested->>'funding_txn_id' = a->>'funding_txn_id'
         and (requested->>'allocated_unused_iqd')::numeric > 0
       limit 1;
    end if;
    if coalesce(take_iqd,0) <= 0 then continue; end if;
    left_want := left_want - take_iqd;

    entry_unused_orig := case when a->>'currency' = 'IQD' then round(take_iqd,2)
                         else round(take_iqd / (a->>'exchange_rate')::numeric,2) end;
    entry_refundable_orig := greatest(least(round(entry_unused_orig * (a->>'fee_rate')::numeric,2),
                                            (a->>'available_fee_original')::numeric),0);
    entry_fee_iqd := case when a->>'currency' = 'IQD' then entry_refundable_orig
                     else round(entry_refundable_orig * (a->>'exchange_rate')::numeric,2) end;
    refundable_fee_iqd := refundable_fee_iqd + entry_fee_iqd;
    refundable_fee_usd := refundable_fee_usd + case when a->>'currency' = 'USD' then entry_refundable_orig
                              else round(entry_refundable_orig / (a->>'exchange_rate')::numeric,2) end;
    allocations := allocations || ((a - 'available_fee_original') || jsonb_build_object(
      'allocated_unused_iqd', round(take_iqd,2), 'allocated_unused_original', entry_unused_orig,
      'refundable_fee_original', entry_refundable_orig, 'refundable_fee_iqd', entry_fee_iqd));
  end loop;
  want := want - left_want;

  -- A non-funding charge gets the excess calculation only. Any part already
  -- returned by a posted refund is deducted before computing a new one.
  if not funding_based then
    select coalesce(sum(fl.fee_iqd),0), coalesce(sum(fl.fee_usd),0)
      into collected_fee_iqd, collected_fee_usd
      from public.acct_fee_ledger fl
      left join public.acct_transactions t on t.id = fl.source_txn_id
     where fl.project_id = p_project_id and fl.entry_type = 'fee'
       and fl.status in ('posted','settled') and fl.calc_basis not in ('funding','income')
       and not coalesce(t.kind in ('material','labor','expense')
         and t.status = any(public.acct_actual_statuses('expense'))
         and public.acct_cost_bearer(t.payment_source,t.meta) = 'client'
         and t.deleted_at is null,false);

    excess_fee_iqd := greatest(collected_fee_iqd - already_refunded_excess_iqd,0);
    -- An excess has no single funding-entry rate. Use its fee rows'
    -- historical USD equivalent in proportion to the amount remaining.
    if excess_fee_iqd > 0 then
      excess_fee_usd := round(collected_fee_usd * excess_fee_iqd / collected_fee_iqd,2);
    end if;
  end if;

  return jsonb_build_object(
    'project_id', p_project_id, 'funding_based', funding_based,
    'gross_funding_iqd', round(gross_iqd,2), 'initial_fee_iqd', round(initial_fee_iqd,2),
    'net_construction_funding_iqd', round(net_pool,2), 'approved_expenses_iqd', round(expenses_iqd,2),
    'already_refunded_iqd', round(already_refunded_iqd,2), 'unused_net_funding_iqd', round(unused_total_iqd,2),
    'refund_principal_iqd', round(want,2), 'refundable_fee_iqd', round(refundable_fee_iqd + excess_fee_iqd,2),
    'refundable_fee_usd', round(refundable_fee_usd + excess_fee_usd,2), 'excess_fee_iqd', round(excess_fee_iqd,2),
    'total_refund_iqd', round(want + refundable_fee_iqd + excess_fee_iqd,2),
    'retained_fee_iqd', round(greatest(initial_fee_iqd - already_refunded_fee_iqd - refundable_fee_iqd - excess_fee_iqd,0),2),
    'partial', want < unused_total_iqd, 'allocations', allocations,
    'allocation_method', case when manual then 'manual' else 'FIFO' end, 'computed_at', now());
end;
$$;

-- Preserve the viewer wrapper and the rest of the authoritative financial
-- summary while completing the historical USD fields.
do $migration$
declare
  src text := pg_get_functiondef('public.acct_project_financials(text)'::regprocedure);
begin
  if position('a_remain_usd := a_net_usd - a_cost_usd - fee_expense_usd;' in src) = 0
     or position('co_net_usd := larsa_rev_usd - co_exp_usd;' in src) = 0
     or position('refunded_principal_iqd numeric := 0;' in src) = 0 then
    raise exception 'ACCT_MIGRATION: unexpected project financials function';
  end if;
  src := replace(src, 'refunded_principal_iqd numeric := 0;',
    'refunded_principal_iqd numeric := 0; refunded_principal_usd numeric := 0;
     fee_refunded_usd numeric := 0; adj_usd numeric := 0;');
  src := replace(src,
    $old$  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_expense_iqd, fee_expense_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'project_expense';$old$,
    $new$  select coalesce(sum(fl.fee_iqd),0), coalesce(sum(fl.fee_usd),0) into fee_expense_iqd, fee_expense_usd
    from public.acct_fee_ledger fl left join public.acct_transactions t on t.id = fl.source_txn_id
   where fl.project_id = proj.id and fl.entry_type = 'fee' and fl.status in ('posted','settled')
     and fl.treatment = 'project_expense'
     and (t.id is null or public.acct_cost_bearer(t.payment_source,t.meta) = 'client');$new$);
  src := replace(src, '  a_remain_usd := a_net_usd - a_cost_usd - fee_expense_usd;',
    $sql$
  -- Allocated fee reversals retain their original ledger exchange rate.
  -- The unallocated balance was paid using the refund transaction's rate.
  select coalesce(sum(case when t.meta->>'principal_iqd' is null then t.amount_usd
                           else round((t.meta->>'principal_iqd')::numeric / t.exchange_rate,2) end),0),
         coalesce(sum(fee.refunded_iqd),0),
         coalesce(sum(coalesce(rev.usd,0) + round(greatest(fee.refunded_iqd - coalesce(rev.iqd,0),0)
                                                 / t.exchange_rate,2)),0)
    into refunded_principal_usd, fee_refunded_iqd, fee_refunded_usd
    from public.acct_transactions t
    left join lateral (
      select -sum(fl.fee_iqd) as iqd, -sum(fl.fee_usd) as usd
        from public.acct_fee_ledger fl
       where fl.project_id = proj.id and fl.refund_settlement_id::text = t.meta->>'settlement_id'
         and fl.entry_type = 'fee_reversal' and fl.status in ('posted','settled')
    ) rev on true
    cross join lateral (
      select coalesce((t.meta->>'fee_refund_iqd')::numeric, (t.meta->>'fee_iqd')::numeric, rev.iqd,0) as refunded_iqd
    ) fee
   where t.project_id = proj.id and t.kind = 'refund'
     and t.status in ('posted','paid') and t.deleted_at is null;

  if fee_refunded_iqd = 0 then
    fee_refunded_iqd := fee_reversed_iqd;
    select coalesce(-sum(fee_usd),0) into fee_refunded_usd
      from public.acct_fee_ledger where project_id = proj.id
       and entry_type in ('fee_reversal','fee_adjustment') and status in ('posted','settled');
  end if;

  select coalesce(sum(amount_usd),0) into adj_usd
    from public.acct_transactions where project_id = proj.id and kind = 'adjustment'
     and status = 'posted' and deleted_at is null;

  a_remain_usd := a_net_usd - a_cost_usd - fee_expense_usd - refunded_principal_usd + adj_usd;
$sql$);
  src := replace(src, 'w_remain_usd := a_net_usd - w_cost_usd - fee_expense_usd;',
    'w_remain_usd := a_net_usd - w_cost_usd - fee_expense_usd - refunded_principal_usd + adj_usd;');
  src := replace(src, 'co_net_usd := larsa_rev_usd - co_exp_usd;',
    'co_net_usd := larsa_rev_usd - co_exp_usd - fee_refunded_usd;');
  src := replace(src, '''fee_refunds_reversals_iqd'', round(fee_refunded_iqd,2),',
    '''fee_refunds_reversals_iqd'', round(fee_refunded_iqd,2),
       ''fee_refunds_reversals_usd'', round(fee_refunded_usd,2),');
  src := replace(src, '''refunded_principal_to_date_iqd'', round(refunded_principal_iqd,2),',
    '''refunded_principal_to_date_iqd'', round(refunded_principal_iqd,2),
       ''refunded_principal_to_date_usd'', round(refunded_principal_usd,2),');
  src := replace(src,
    'from public.acct_refund_settlements where project_id = proj.id and status = ''executed'';',
    'from public.acct_refund_settlements rs join public.acct_transactions rt on rt.id = rs.refund_txn_id
     where rs.project_id = proj.id and rs.status = ''posted''
       and rt.status in (''posted'',''paid'') and rt.deleted_at is null;');
  src := replace(src, '''final_settled_iqd'', case when settled_count > 0',
    '''final_settled_iqd'', case when settled_count > 0 and (refund_calc->>''total_refund_iqd'')::numeric = 0');
  src := replace(src, '''is_final'', settled_count > 0,',
    '''is_final'', settled_count > 0 and (refund_calc->>''total_refund_iqd'')::numeric = 0,');
  execute src;
end;
$migration$;

-- Serialize postings against the same project. A second approval must
-- recompute after the first commits and use the new remaining amounts.
do $migration$
declare
  src text := pg_get_functiondef('public.acct_execute_refund(jsonb,uuid,uuid)'::regprocedure);
  check_anchor text := '  if s.status not in (''draft'',''pending_approval'',''approved'') then';
begin
  if position(check_anchor in src) = 0 then
    raise exception 'ACCT_MIGRATION: unexpected refund execution function';
  end if;
  src := replace(src, check_anchor,
    $sql$  perform pg_advisory_xact_lock(hashtextextended('acct_refund:' || s.project_id,0));
  select * into s from public.acct_refund_settlements where id = p_settlement_id for update;
  if s.id is null then raise exception 'ACCT_REFUND: settlement not found'; end if;
$sql$ || check_anchor);
  src := replace(src, 'or round((fresh->>''refundable_fee_iqd'')::numeric,2) <> round(s.refundable_fee,2) then',
    'or round((fresh->>''refundable_fee_iqd'')::numeric,2) <> round(s.refundable_fee,2)
     or (fresh->>''total_refund_iqd'')::numeric <= 0
     or s.allocations is distinct from fresh->''allocations'' then');
  src := replace(src, 'set status = ''draft'',',
    'set status = case when (fresh->>''total_refund_iqd'')::numeric <= 0 then ''cancelled'' else ''draft'' end,');
  src := replace(src, 'allocations = fresh->''allocations'',',
    'allocations = fresh->''allocations'',
            excess_fee_refund = (fresh->>''excess_fee_iqd'')::numeric,
            partial = (fresh->>''partial'')::boolean,');
  src := replace(src, '    perform public.acct_log(actor, s.project_id, ''refund_settlement'', s.id::text, ''Refund Settlement Recalculated'',',
    $sql$    if (fresh->>'total_refund_iqd')::numeric <= 0 then
      perform public.acct_log(actor, s.project_id, 'refund_settlement', s.id::text, 'Refund Settlement Cancelled',
        'The remaining refundable balance is zero', p_approval, to_jsonb(s), fresh, null);
      return jsonb_build_object('ok', false, 'error', 'NO_REFUND_AVAILABLE',
        'message', 'No refundable balance remains. The settlement has been cancelled.');
    end if;
    perform public.acct_log(actor, s.project_id, 'refund_settlement', s.id::text, 'Refund Settlement Recalculated',$sql$);
  src := replace(src, 'Approved expenses changed before approval; settlement recomputed and returned to draft',
    'Refund balance or allocation changed before approval; settlement recomputed and returned to draft');
  src := replace(src, 'Approved expenses changed since this settlement was drafted. It has been recalculated - review and request approval again.',
    'The refund balance or allocation changed. Review the recalculated settlement and request approval again.');
  execute src;
end;
$migration$;
