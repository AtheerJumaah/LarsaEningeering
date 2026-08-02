-- ===========================================================================
-- Larsa Control — accounting migration 010: the payroll portal read path.
--
-- WHY
--   Migration 009 gave payroll an authoritative home and gave the employee a
--   way to see their own half of it. This adds the other half: one call that
--   answers "what is in this pay run", so an accountant can run the whole
--   cycle — people, run, items, approval, payment, publication — from a
--   single screen instead of four scattered ones.
--
--   It reads the same rows My Pay reads. There is one payroll truth and two
--   lenses on it: the portal for whoever runs payroll, My Pay for the person
--   being paid. Nothing is recomputed here that 009 did not already decide.
--
-- Additive only. No table, column, function or grant from 009 is changed.
-- ===========================================================================

create or replace function public.pay_period_detail(actor jsonb, p_period_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  per public.pay_periods;
  lines jsonb;
  payments jsonb;
  net_iqd numeric(18,2);
  paid_iqd numeric(18,2);
  by_cur jsonb := '{}'::jsonb;
  cur_row record;
begin
  -- Seeing a whole run means seeing everybody's pay in it, so this is the
  -- confidential permission and nothing less.
  perform public.acct_check_perm(actor, 'payroll_view_all');

  select * into per from public.pay_periods where id = p_period_id;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;

  -- One line per employee in the run, with the components kept apart.
  select coalesce(jsonb_agg(x order by x->>'full_name'), '[]'::jsonb) into lines
  from (
    select jsonb_build_object(
      'employee_email', i.employee_email,
      'full_name', coalesce(e.full_name, i.employee_email),
      'employee_no', e.employee_no,
      'position', e.position,
      'base_salary_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'base_salary'), 0),
      'commission_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'commission'), 0),
      'bonus_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type in ('bonus','allowance')), 0),
      'deduction_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'deduction'), 0),
      'advance_repayment_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'advance_repayment'), 0),
      'reimbursement_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'reimbursement'), 0),
      'net_iqd', coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_iqd), 0),
      'items', jsonb_agg(jsonb_build_object(
          'id', i.id, 'item_type', i.item_type, 'description', i.description,
          'original_amount', i.original_amount, 'original_currency', i.original_currency,
          'exchange_rate', i.exchange_rate, 'sign', public.pay_item_sign(i.item_type),
          'amount_iqd', i.amount_iqd, 'status', i.status,
          -- The proof that this cost reached the ledger exactly once.
          'txn_id', i.txn_id) order by i.item_type),
      'posted_items', count(*) filter (where i.txn_id is not null),
      'paid_iqd', coalesce((select sum(pp.amount_iqd) from public.pay_payments pp
                             where pp.period_id = per.id and pp.employee_email = i.employee_email
                               and pp.status = 'paid'), 0)
    ) as x
    from public.pay_items i
    left join public.pay_employees e on e.email = i.employee_email
   where i.period_id = per.id and i.deleted_at is null
   group by i.employee_email, e.full_name, e.employee_no, e.position
  ) rows;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pp.id, 'employee_email', pp.employee_email, 'paid_on', pp.paid_on,
           'amount', pp.original_amount, 'currency', pp.original_currency,
           'amount_iqd', pp.amount_iqd, 'status', pp.status, 'method', pp.method,
           'reversal_reason', pp.reversal_reason) order by pp.paid_on desc), '[]'::jsonb)
    into payments
    from public.pay_payments pp where pp.period_id = per.id;

  select coalesce(sum(public.pay_item_sign(item_type) * amount_iqd), 0) into net_iqd
    from public.pay_items where period_id = per.id and deleted_at is null and status <> 'rejected';
  select coalesce(sum(case when status = 'paid' then amount_iqd else 0 end), 0) into paid_iqd
    from public.pay_payments where period_id = per.id;

  -- Currencies stay apart here too: a run can mix them and the total must
  -- never pretend otherwise.
  for cur_row in
    select original_currency as cur, sum(public.pay_item_sign(item_type) * original_amount) as net
      from public.pay_items
     where period_id = per.id and deleted_at is null and status <> 'rejected'
     group by original_currency
  loop
    by_cur := by_cur || jsonb_build_object(cur_row.cur, jsonb_build_object('net', cur_row.net));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'period', to_jsonb(per),
    'lines', lines,
    'payments', payments,
    'net_iqd', net_iqd,
    'paid_iqd', paid_iqd,
    'outstanding_iqd', round(net_iqd - paid_iqd, 2),
    'by_currency', by_cur,
    'employees_in_run', jsonb_array_length(lines),
    'computed_at', now());
end;
$$;

do $$
begin
  revoke all on function public.pay_period_detail(jsonb,uuid) from public, anon;
  grant execute on function public.pay_period_detail(jsonb,uuid) to authenticated;
exception when others then null;
end;
$$;
