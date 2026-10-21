-- Larsa Control — Accounting repair 024
-- Keep refunds on the same client-fund basis as authoritative financials.
-- A cost paid from Larsa/company funds must never consume client funding or
-- reduce the client's refundable balance. Expense-based fees also return any
-- collected amount that has not been earned by approved client costs.

create or replace function public.acct_compute_refund(
  p_project_id text,
  p_refund_amount_iqd numeric default null,
  p_manual_allocations jsonb default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
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

  -- Only client-borne construction costs consume client funding.
  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0)
    into expenses_iqd, expenses_usd
    from public.acct_transactions
   where project_id = proj.id and kind in ('material','labor','expense')
     and status = any (public.acct_actual_statuses('expense'))
     and public.acct_cost_bearer(payment_source, meta) = 'client'
     and deleted_at is null;

  -- Project-expense fees consume client funds only when their source cost is
  -- client-borne. A missing source is treated as client-borne for backwards
  -- compatibility with older fee rows.
  select expenses_iqd + coalesce(sum(fl.fee_iqd),0) into expenses_iqd
    from public.acct_fee_ledger fl
    left join public.acct_transactions st on st.id = fl.source_txn_id
   where fl.project_id = proj.id and fl.entry_type = 'fee'
     and fl.status in ('posted','settled') and fl.treatment = 'project_expense'
     and (st.id is null or public.acct_cost_bearer(st.payment_source, st.meta) = 'client');

  select coalesce(sum((coalesce(meta->>'principal_iqd', amount_iqd::text))::numeric),0)
    into already_refunded_iqd
    from public.acct_transactions
   where project_id = proj.id and kind = 'refund' and status in ('posted','paid')
     and deleted_at is null;

  remaining := expenses_iqd + already_refunded_iqd;

  for f in
    select t.*, fl.id as fee_id, fl.fee_rate as fee_rate, fl.fee_iqd as fee_iqd,
           fl.fee_usd as fee_usd, fl.treatment as fee_treat,
           fl.calc_method as fee_method, fl.status as fee_status
      from public.acct_transactions t
      left join public.acct_fee_ledger fl
        on fl.source_txn_id = t.id and fl.entry_type = 'fee'
       and fl.status in ('posted','settled')
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
    entry_rate := coalesce(nullif(f.exchange_rate,0), 1);
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

      entry_rate := coalesce(nullif((a->>'exchange_rate')::numeric,0),1);
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

  -- Expense-based projects return fees collected above what approved
  -- client-borne expenses have earned.
  if not funding_based then
    select coalesce(sum(fee_iqd),0) into collected_fee_iqd
      from public.acct_fee_ledger
     where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled');
    select coalesce(sum(fl.fee_iqd),0) into earned_fee_iqd
      from public.acct_fee_ledger fl
      join public.acct_transactions t on t.id = fl.source_txn_id
     where fl.project_id = proj.id and fl.entry_type = 'fee' and fl.status in ('posted','settled')
       and t.kind in ('material','labor','expense')
       and t.status = any (public.acct_actual_statuses('expense'))
       and public.acct_cost_bearer(t.payment_source, t.meta) = 'client'
       and t.deleted_at is null;
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
$$;

revoke all on function public.acct_compute_refund(text,numeric,jsonb) from public, anon;
grant execute on function public.acct_compute_refund(text,numeric,jsonb) to authenticated;
