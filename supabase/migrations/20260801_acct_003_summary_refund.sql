-- ============================================================
-- Larsa Control — Accounting upgrade, part 3:
-- project financial summary + the Larsa unused-funding refund rule.
--
-- The refund rule (fixed, never a proportional substitute):
--   Unused Net Funding      = Initial Net Construction Funding
--                             − Approved/Posted Project Expenses
--   Refundable Consultancy  = Unused Net Funding × ORIGINAL snapshotted rate
--   Total Client Refund     = Unused Net Funding + Refundable Consultancy Fee
--   Final Fee Retained      = Initial Consultancy Fee − Refundable Fee
-- ============================================================

-- Statuses that count as real (actual) money movement.
create or replace function public.acct_actual_statuses(p_kind text)
returns text[]
language sql immutable
as $$
  select case
    when p_kind = 'funding' then array['received','posted','paid']
    when p_kind = 'revenue' then array['received','posted','paid']
    else array['approved','posted','paid']
  end;
$$;

-- ------------------------------------------------------------
-- FIFO (or manual) allocation of an unused amount across the
-- project's posted funding entries, each with its own historical
-- exchange-rate and consultancy-rate snapshot.
-- Returns: { allocations:[...], unused_net, refundable_fee, ... }
-- Amounts are reported per entry in the ENTRY's original currency,
-- with historical IQD/USD equivalents; totals are historical
-- equivalents (raw USD and IQD are never added together).
-- ------------------------------------------------------------
create or replace function public.acct_compute_refund(
  p_project_id text,
  p_refund_amount_iqd numeric default null,     -- partial refund: unused IQD-equivalent being returned; null = all unused
  p_manual_allocations jsonb default null)      -- [{funding_txn_id, allocated_unused_iqd}]
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  f record;
  fee record;
  expenses_iqd numeric := 0;
  expenses_usd numeric := 0;
  gross_iqd numeric := 0;
  initial_fee_iqd numeric := 0;
  initial_fee_total numeric := 0;    -- in project currency terms via per-entry currency (reported per entry)
  net_pool numeric := 0;             -- IQD-equivalent net construction funding
  consume numeric := 0;
  remaining numeric := 0;
  alloc jsonb := '[]'::jsonb;
  want numeric;
  manual jsonb;
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

  remaining := expenses_iqd + already_refunded_iqd;  -- total consumption to allocate FIFO

  -- Walk posted funding entries oldest-first; consume expenses; what is left
  -- of each entry's NET amount is that entry's unused funding.
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

    -- Net construction funding from THIS entry (fee deducted only when the
    -- treatment actually takes the fee out of the funding).
    entry_unused_iqd := f.amount_iqd - case when fee_treatment = 'deduct_from_funding' then coalesce(f.fee_iqd,0) else 0 end;
    net_pool := net_pool + entry_unused_iqd;

    -- FIFO consumption by expenses (and prior refunds).
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

  -- Requested principal (IQD equivalent). Default: everything unused.
  unused_total_iqd := greatest(net_pool - expenses_iqd - already_refunded_iqd, 0);
  want := least(coalesce(p_refund_amount_iqd, unused_total_iqd), unused_total_iqd);

  -- Distribute `want` across entries: manual allocations if provided
  -- (validated against each entry's available unused), else FIFO.
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
$$;

-- ------------------------------------------------------------
-- Create a draft refund settlement from the computation above.
-- Posting it requires the protected approval workflow.
-- ------------------------------------------------------------
create or replace function public.acct_create_refund_settlement(
  actor jsonb, p_project_id text,
  p_refund_amount_iqd numeric default null,
  p_manual_allocations jsonb default null,
  p_settlement_rate numeric default null,
  p_reason text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  calc jsonb;
  proj record;
  row_s public.acct_refund_settlements;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_REFUND: unknown project'; end if;

  calc := public.acct_compute_refund(p_project_id, p_refund_amount_iqd, p_manual_allocations);
  if (calc->>'total_refund_iqd')::numeric <= 0 then
    raise exception 'ACCT_REFUND: there is no unused funding to refund';
  end if;

  insert into public.acct_refund_settlements
    (project_id, status, currency, unused_net_funding, refundable_fee, total_refund,
     initial_fee, retained_fee, partial, refund_amount_requested, allocations, allocation_method,
     settlement_rate, excess_fee_refund, reason, is_sample, created_by)
  values
    (proj.id, 'draft', 'IQD',
     (calc->>'refund_principal_iqd')::numeric,
     (calc->>'refundable_fee_iqd')::numeric,
     (calc->>'total_refund_iqd')::numeric,
     (calc->>'initial_fee_iqd')::numeric,
     (calc->>'retained_fee_iqd')::numeric,
     (calc->>'partial')::boolean,
     p_refund_amount_iqd,
     calc->'allocations',
     calc->>'allocation_method',
     p_settlement_rate,
     (calc->>'excess_fee_iqd')::numeric,
     p_reason, proj.is_sample, lower(coalesce(actor->>'email','')))
  returning * into row_s;

  perform public.acct_log(actor, proj.id, 'refund_settlement', row_s.id::text, 'Refund Settlement Drafted',
    p_reason, null, null, to_jsonb(row_s),
    format('Refund %s IQD (principal %s + refundable fee %s), retained fee %s',
      calc->>'total_refund_iqd', calc->>'refund_principal_iqd', calc->>'refundable_fee_iqd', calc->>'retained_fee_iqd'));
  return jsonb_build_object('ok', true, 'settlement', to_jsonb(row_s), 'calc', calc);
end;
$$;

-- ------------------------------------------------------------
-- Internal: execute an APPROVED refund settlement inside one
-- database transaction. Reverses fees per allocation using each
-- entry's historical snapshots; the original fee entries are never
-- deleted or overwritten — a linked negative fee_reversal is added.
-- Called only by acct_decide_approval (part 4).
-- ------------------------------------------------------------
create or replace function public.acct_execute_refund(actor jsonb, p_settlement_id uuid, p_approval uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  s record;
  proj record;
  fresh jsonb;
  a jsonb;
  refund_txn public.acct_transactions;
  fx_txn public.acct_transactions;
  new_no text;
  fee_src record;
  reversal_iqd numeric;
  reversal_orig numeric;
  entry_cur text;
  entry_rate numeric;
  settle_iqd numeric;
  fx_diff numeric := 0;
begin
  select * into s from public.acct_refund_settlements where id = p_settlement_id;
  if s.id is null then raise exception 'ACCT_REFUND: settlement not found'; end if;
  if s.status not in ('draft','pending_approval','approved') then
    raise exception 'ACCT_REFUND: settlement is %', s.status;
  end if;
  select * into proj from public.acct_projects where id = s.project_id;

  -- If approved expenses moved since the settlement was drafted, the
  -- numbers must be recomputed and re-approved — never post stale math.
  fresh := public.acct_compute_refund(s.project_id, s.refund_amount_requested,
             case when s.allocation_method = 'manual' then s.allocations else null end);
  if round((fresh->>'total_refund_iqd')::numeric,2) <> round(s.total_refund,2)
     or round((fresh->>'refundable_fee_iqd')::numeric,2) <> round(s.refundable_fee,2) then
    update public.acct_refund_settlements
       set status = 'draft',
           unused_net_funding = (fresh->>'refund_principal_iqd')::numeric,
           refundable_fee = (fresh->>'refundable_fee_iqd')::numeric,
           total_refund = (fresh->>'total_refund_iqd')::numeric,
           initial_fee = (fresh->>'initial_fee_iqd')::numeric,
           retained_fee = (fresh->>'retained_fee_iqd')::numeric,
           allocations = fresh->'allocations',
           computed_at = now()
     where id = s.id;
    perform public.acct_log(actor, s.project_id, 'refund_settlement', s.id::text, 'Refund Settlement Recalculated',
      'Approved expenses changed before approval; settlement recomputed and returned to draft', p_approval, to_jsonb(s), fresh, null);
    return jsonb_build_object('ok', false, 'error', 'RECALCULATED',
      'message', 'Approved expenses changed since this settlement was drafted. It has been recalculated — review and request approval again.');
  end if;

  -- 1. The refund transaction itself (money leaving to the client).
  new_no := 'LRS-TXN-' || lpad(nextval('public.acct_txn_no_seq')::text, 6, '0');
  insert into public.acct_transactions
    (txn_no, receipt_no, project_id, kind, category, description, txn_date, status,
     original_amount, original_currency, exchange_rate, rate_source, rate_note, rate_confirmed_by,
     amount_iqd, amount_usd, is_sample, meta, created_by_email, created_by_name, created_by_role,
     approved_by, approved_at, posted_at)
  values
    (new_no, 'LRS-RCP-' || lpad(nextval('public.acct_receipt_no_seq')::text, 6, '0'),
     s.project_id, 'refund', 'Client Refund',
     format('Refund of unused funding (%s) + refundable consultancy fee (%s)', s.unused_net_funding, s.refundable_fee),
     current_date, 'posted',
     s.total_refund, 'IQD',
     coalesce(s.settlement_rate, (public.acct_resolve_rate(s.project_id, null)->>'rate')::numeric),
     case when s.settlement_rate is not null then 'transaction_override' else 'project_default' end,
     'Refund settlement ' || s.id, lower(coalesce(actor->>'email','')),
     s.total_refund,
     round(s.total_refund / coalesce(s.settlement_rate, (public.acct_resolve_rate(s.project_id, null)->>'rate')::numeric), 2),
     s.is_sample,
     jsonb_build_object('settlement_id', s.id, 'principal_iqd', s.unused_net_funding, 'fee_refund_iqd', s.refundable_fee),
     lower(coalesce(actor->>'email','')), actor->>'name', actor->>'role',
     lower(coalesce(actor->>'email','')), now(), now())
  returning * into refund_txn;

  -- 2. Reverse the refundable part of each allocated fee at its own
  --    historical snapshot. Original fees stay untouched; each gets a
  --    linked negative reversal entry.
  for a in select * from jsonb_array_elements(s.allocations)
  loop
    reversal_orig := coalesce((a->>'refundable_fee_original')::numeric, 0);
    if reversal_orig <= 0 then continue; end if;
    entry_cur := a->>'currency';
    entry_rate := (a->>'exchange_rate')::numeric;
    select * into fee_src from public.acct_fee_ledger where id = nullif(a->>'fee_id','')::uuid;

    insert into public.acct_fee_ledger
      (project_id, source_txn_id, entry_type, calc_method, fee_rate, calc_basis, basis_amount,
       fee_amount, currency, exchange_rate, fee_iqd, fee_usd, treatment, config_source, status,
       waived, is_sample, refund_settlement_id, reversal_of, note, created_by, approved_by)
    values
      (s.project_id, nullif(a->>'funding_txn_id','')::uuid, 'fee_reversal',
       coalesce(fee_src.calc_method,'percentage'), coalesce((a->>'fee_rate')::numeric, fee_src.fee_rate),
       coalesce(fee_src.calc_basis,'funding'),
       -coalesce((a->>'allocated_unused_original')::numeric,0),
       -reversal_orig, entry_cur, entry_rate,
       -case when entry_cur = 'IQD' then reversal_orig else round(reversal_orig * entry_rate,2) end,
       -case when entry_cur = 'USD' then reversal_orig else round(reversal_orig / entry_rate,2) end,
       coalesce(fee_src.treatment,'deduct_from_funding'), 'legacy', 'posted',
       false, s.is_sample, s.id, fee_src.id,
       format('Refundable consultancy fee on unused funding — refund %s', refund_txn.txn_no),
       lower(coalesce(actor->>'email','')), lower(coalesce(actor->>'email','')))
    ;
    -- The original fee is now settled (no longer provisional).
    if fee_src.id is not null then
      update public.acct_fee_ledger set provisional = false, status = 'settled' where id = fee_src.id and status = 'posted';
    end if;
  end loop;

  -- 3. FX gain/loss: if the refund is actually paid at a different rate
  --    than the historical snapshots, record the difference as a separate
  --    adjustment — the original transactions are never rewritten.
  if s.settlement_rate is not null then
    settle_iqd := 0; fx_diff := 0;
    for a in select * from jsonb_array_elements(s.allocations)
    loop
      if (a->>'currency') = 'USD' then
        fx_diff := fx_diff + round(
          (coalesce((a->>'allocated_unused_original')::numeric,0) + coalesce((a->>'refundable_fee_original')::numeric,0))
          * (s.settlement_rate - (a->>'exchange_rate')::numeric), 2);
      end if;
    end loop;
    if abs(fx_diff) >= 0.01 then
      new_no := 'LRS-TXN-' || lpad(nextval('public.acct_txn_no_seq')::text, 6, '0');
      insert into public.acct_transactions
        (txn_no, project_id, kind, category, description, txn_date, status,
         original_amount, original_currency, exchange_rate, rate_source, rate_note,
         amount_iqd, amount_usd, is_sample, meta,
         created_by_email, created_by_name, created_by_role, approved_by, approved_at, posted_at)
      values
        (new_no, s.project_id, 'adjustment', 'FX Gain/Loss',
         format('Foreign-exchange %s on refund settlement %s (settlement rate %s vs historical snapshots)',
           case when fx_diff > 0 then 'loss' else 'gain' end, s.id, s.settlement_rate),
         current_date, 'posted', fx_diff, 'IQD', s.settlement_rate, 'transaction_override',
         'FX difference — historical snapshots preserved', fx_diff, round(fx_diff / s.settlement_rate, 2),
         s.is_sample, jsonb_build_object('settlement_id', s.id),
         lower(coalesce(actor->>'email','')), actor->>'name', actor->>'role',
         lower(coalesce(actor->>'email','')), now(), now())
      returning * into fx_txn;
    end if;
  end if;

  update public.acct_refund_settlements
     set status = 'posted', refund_txn_id = refund_txn.id,
         fx_adjustment_txn_id = fx_txn.id, fx_gain_loss_iqd = coalesce(fx_diff,0),
         approval_request_id = p_approval,
         posted_by = lower(coalesce(actor->>'email','')), posted_at = now()
   where id = s.id;

  perform public.acct_log(actor, s.project_id, 'refund_settlement', s.id::text, 'Client Refund Posted', s.reason, p_approval,
    to_jsonb(s), (select to_jsonb(x) from public.acct_refund_settlements x where x.id = s.id),
    format('Refund %s: principal %s IQD + refundable fee %s IQD; retained fee %s IQD',
      refund_txn.txn_no, s.unused_net_funding, s.refundable_fee, s.retained_fee));

  return jsonb_build_object('ok', true, 'refund_txn', to_jsonb(refund_txn),
    'settlement', (select to_jsonb(x) from public.acct_refund_settlements x where x.id = s.id));
end;
$$;

-- ------------------------------------------------------------
-- Full project financial summary (§4 of the specification).
-- Separated concepts, never mixed: contract value / budget /
-- funding / actual cost / fees / available funds / unused funding /
-- client refund / Larsa revenue. Historical snapshots only.
-- ------------------------------------------------------------
create or replace function public.acct_project_summary(p_project_id text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  gross_iqd numeric := 0; gross_usd numeric := 0;
  mat_iqd numeric := 0;   mat_usd numeric := 0;
  lab_iqd numeric := 0;   lab_usd numeric := 0;
  oth_iqd numeric := 0;   oth_usd numeric := 0;
  rev_iqd numeric := 0;   rev_usd numeric := 0;
  fee_posted_iqd numeric := 0; fee_posted_usd numeric := 0;
  fee_deduct_iqd numeric := 0; fee_deduct_usd numeric := 0;
  fee_expense_iqd numeric := 0; fee_expense_usd numeric := 0;
  fee_revenue_iqd numeric := 0;                      -- larsa_revenue treatment (kept OUT of project cost)
  fee_reversed_iqd numeric := 0; fee_reversed_usd numeric := 0;
  pending_iqd numeric := 0; pending_usd numeric := 0;
  refunded_iqd numeric := 0;
  adj_iqd numeric := 0;
  budget numeric; budget_cur text;
  actual_cost_iqd numeric; actual_cost_usd numeric;
  net_funding_iqd numeric; net_funding_usd numeric;
  total_used_iqd numeric; total_used_usd numeric;
  refund_calc jsonb;
  latest_progress record;
  cost_progress numeric;
  cost_in_budget_cur numeric;
begin
  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_SUMMARY: unknown project'; end if;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into gross_iqd, gross_usd
    from public.acct_transactions where project_id = proj.id and kind = 'funding'
     and status = any (public.acct_actual_statuses('funding')) and deleted_at is null;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into mat_iqd, mat_usd
    from public.acct_transactions where project_id = proj.id and kind = 'material'
     and status = any (public.acct_actual_statuses('material')) and deleted_at is null;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into lab_iqd, lab_usd
    from public.acct_transactions where project_id = proj.id and kind = 'labor'
     and status = any (public.acct_actual_statuses('labor')) and deleted_at is null;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into oth_iqd, oth_usd
    from public.acct_transactions where project_id = proj.id and kind = 'expense'
     and status = any (public.acct_actual_statuses('expense')) and deleted_at is null;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into rev_iqd, rev_usd
    from public.acct_transactions where project_id = proj.id and kind = 'revenue'
     and status = any (public.acct_actual_statuses('revenue')) and deleted_at is null;

  select coalesce(sum(amount_iqd),0), coalesce(sum(amount_usd),0) into pending_iqd, pending_usd
    from public.acct_transactions where project_id = proj.id and kind in ('material','labor','expense')
     and status in ('draft','pending') and deleted_at is null;

  select coalesce(sum(amount_iqd),0) into adj_iqd
    from public.acct_transactions where project_id = proj.id and kind = 'adjustment'
     and status = 'posted' and deleted_at is null;

  select coalesce(sum((coalesce(meta->>'principal_iqd', amount_iqd::text))::numeric),0) into refunded_iqd
    from public.acct_transactions where project_id = proj.id and kind = 'refund'
     and status in ('posted','paid') and deleted_at is null;

  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_posted_iqd, fee_posted_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled');

  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_deduct_iqd, fee_deduct_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'deduct_from_funding';

  select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_expense_iqd, fee_expense_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'project_expense';

  select coalesce(sum(fee_iqd),0) into fee_revenue_iqd
    from public.acct_fee_ledger where project_id = proj.id and entry_type = 'fee' and status in ('posted','settled')
     and treatment = 'larsa_revenue';

  select coalesce(-sum(fee_iqd),0), coalesce(-sum(fee_usd),0) into fee_reversed_iqd, fee_reversed_usd
    from public.acct_fee_ledger where project_id = proj.id and entry_type in ('fee_reversal','fee_adjustment')
     and status in ('posted','settled');

  actual_cost_iqd := mat_iqd + lab_iqd + oth_iqd;
  actual_cost_usd := mat_usd + lab_usd + oth_usd;
  -- Net Construction Funding = Gross − fee deducted FROM FUNDING only.
  net_funding_iqd := gross_iqd - fee_deduct_iqd;
  net_funding_usd := gross_usd - fee_deduct_usd;
  -- Total Used = Actual Construction Cost + fee charged to project funding
  -- (deduct treatment) + fee recorded as a project expense. A fee recorded
  -- as separate Larsa revenue is NOT part of the project's cost.
  total_used_iqd := actual_cost_iqd + fee_deduct_iqd + fee_expense_iqd;
  total_used_usd := actual_cost_usd + fee_deduct_usd + fee_expense_usd;

  refund_calc := public.acct_compute_refund(proj.id, null, null);

  select * into latest_progress from public.acct_progress_updates
   where project_id = proj.id order by update_date desc, created_at desc limit 1;

  budget := proj.approved_budget;
  budget_cur := coalesce(proj.budget_currency, proj.currency);
  if budget is not null and budget > 0 then
    cost_in_budget_cur := case when budget_cur = 'IQD' then actual_cost_iqd else actual_cost_usd end;
    cost_progress := round(cost_in_budget_cur / budget * 100, 1);
  end if;

  return jsonb_build_object(
    'project_id', proj.id,
    'currency', proj.currency,
    'contract_value', proj.contract_value,
    'approved_budget', budget,
    'budget_currency', budget_cur,
    'gross_funding_iqd', round(gross_iqd,2),   'gross_funding_usd', round(gross_usd,2),
    'initial_fee_iqd', round(fee_posted_iqd,2),'initial_fee_usd', round(fee_posted_usd,2),
    'fee_deducted_from_funding_iqd', round(fee_deduct_iqd,2),
    'fee_as_project_expense_iqd', round(fee_expense_iqd,2),
    'fee_as_larsa_revenue_iqd', round(fee_revenue_iqd,2),
    'fee_reversed_iqd', round(fee_reversed_iqd,2),
    'net_construction_funding_iqd', round(net_funding_iqd,2),
    'net_construction_funding_usd', round(net_funding_usd,2),
    'materials_iqd', round(mat_iqd,2), 'materials_usd', round(mat_usd,2),
    'labor_iqd', round(lab_iqd,2),     'labor_usd', round(lab_usd,2),
    'other_expenses_iqd', round(oth_iqd,2), 'other_expenses_usd', round(oth_usd,2),
    'actual_construction_cost_iqd', round(actual_cost_iqd,2),
    'actual_construction_cost_usd', round(actual_cost_usd,2),
    'total_used_iqd', round(total_used_iqd,2),
    'total_used_usd', round(total_used_usd,2),
    'revenue_iqd', round(rev_iqd,2), 'revenue_usd', round(rev_usd,2),
    'adjustments_iqd', round(adj_iqd,2),
    'pending_commitments_iqd', round(pending_iqd,2),
    'pending_commitments_usd', round(pending_usd,2),
    'refunded_principal_iqd', round(refunded_iqd,2),
    'remaining_unused_iqd', refund_calc->'unused_net_funding_iqd',
    'refundable_fee_iqd', refund_calc->'refundable_fee_iqd',
    'total_refund_due_iqd', refund_calc->'total_refund_iqd',
    'final_fee_retained_iqd', refund_calc->'retained_fee_iqd',
    'cost_progress_pct', cost_progress,
    'schedule_progress_pct', latest_progress.percent,
    'schedule_progress_date', latest_progress.update_date,
    'schedule_progress_by', latest_progress.updated_by_name,
    'computed_at', now());
end;
$$;

do $$
begin
  revoke all on function public.acct_compute_refund(text,numeric,jsonb) from public, anon;
  grant execute on function public.acct_compute_refund(text,numeric,jsonb) to authenticated;
  revoke all on function public.acct_create_refund_settlement(jsonb,text,numeric,jsonb,numeric,text) from public, anon;
  grant execute on function public.acct_create_refund_settlement(jsonb,text,numeric,jsonb,numeric,text) to authenticated;
  revoke all on function public.acct_execute_refund(jsonb,uuid,uuid) from public, anon, authenticated;
  revoke all on function public.acct_project_summary(text) from public, anon;
  grant execute on function public.acct_project_summary(text) to authenticated;
end;
$$;
