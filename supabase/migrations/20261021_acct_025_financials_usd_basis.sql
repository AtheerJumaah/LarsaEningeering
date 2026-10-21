-- Keep the USD view of client funds in lockstep with the authoritative IQD view.
-- Project-expense consultancy fees are client-funded usage and must be included
-- in total_used_usd and remaining_balance_usd just as they are in IQD.
do $$
declare
  src text;
begin
  select pg_get_functiondef(p.oid)
    into src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'acct_project_financials'
     and pg_get_function_arguments(p.oid) = 'p_project_id text'
   limit 1;

  if src is null then
    raise exception 'ACCT_MIGRATION: acct_project_financials is missing';
  end if;

  if position('fee_expense_usd numeric' in src) = 0 then
    src := replace(src,
      'fee_expense_iqd numeric := 0;',
      'fee_expense_iqd numeric := 0; fee_expense_usd numeric := 0;');
  end if;

  if position('into fee_expense_iqd, fee_expense_usd' in src) = 0 then
    src := replace(src,
      'select coalesce(sum(fee_iqd),0) into fee_expense_iqd',
      'select coalesce(sum(fee_iqd),0), coalesce(sum(fee_usd),0) into fee_expense_iqd, fee_expense_usd');
  end if;

  src := replace(src,
    'a_used_usd := a_cost_usd + fee_deduct_usd;',
    'a_used_usd := a_cost_usd + fee_deduct_usd + fee_expense_usd;');
  src := replace(src,
    'w_used_usd := w_cost_usd + fee_deduct_usd;',
    'w_used_usd := w_cost_usd + fee_deduct_usd + fee_expense_usd;');
  src := replace(src,
    'a_remain_usd := a_net_usd - a_cost_usd;',
    'a_remain_usd := a_net_usd - a_cost_usd - fee_expense_usd;');
  src := replace(src,
    'w_remain_usd := a_net_usd - w_cost_usd;',
    'w_remain_usd := a_net_usd - w_cost_usd - fee_expense_usd;');

  execute src;
end $$;
