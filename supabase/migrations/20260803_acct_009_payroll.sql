-- ===========================================================================
-- Larsa Control — accounting migration 009: payroll, commissions and My Pay
--
-- WHY THIS EXISTS
--   Payroll, commissions and employee records were the last financial
--   collections still living entirely in the browser's localStorage blob:
--   no relational store, no maker-checker, no FX snapshot, no audit trail,
--   and no way for an employee to see their own pay without an accountant
--   opening the admin screen for them. This migration gives them the same
--   authoritative backend every other financial record already has, and adds
--   the employee-facing read path behind it.
--
-- ONE ENTRY, NOT TWO
--   A payroll cost becomes a company expense exactly once. Approving a
--   payroll period posts one acct_transactions row per costed payroll item
--   and stores that transaction's id on the item. Re-approving, re-running or
--   replaying does nothing: the link is a unique constraint, not a promise.
--   Salary expenses that already exist in Accounting without a payroll item
--   are never touched and never duplicated — they go to a mapping queue for
--   an authorised accountant to link by hand.
--
-- PRIVACY
--   Payroll is the most sensitive data in this system. Unlike the acct_*
--   tables, these tables grant NO select to anon or authenticated: there is
--   no direct-query path at all, from the client, the URL, an export or the
--   REST API. Every read goes through a SECURITY DEFINER function that scopes
--   rows to the caller and audits any look at somebody else's pay.
--
-- IMMUTABILITY
--   Every amount carries its own exchange-rate snapshot at the moment it was
--   recorded. Changing the platform or project default rate later cannot move
--   a historical payslip, chart, or accumulated total. Commissions carry the
--   rule that produced them, so changing a commission default only affects
--   commissions created afterwards.
--
-- REVERSIBILITY
--   Additive only: create table if not exists, add column if not exists,
--   create or replace function. No existing table, column, row, function or
--   policy is dropped or rewritten in a lossy way. acct_role_default_perms
--   and acct_get_my_permissions are replaced with supersets of themselves.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Employment and compensation record.
--    Email is the join key: it is the only identifier shared by the staff
--    directory, the accounting permissions table and the ledger.
-- ------------------------------------------------------------
create table if not exists public.pay_employees (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null unique,
  employee_no        text unique,
  full_name          text not null,
  position           text,
  department         text,
  region             text default 'Iraq',
  employment_type    text default 'Employee',
  pay_schedule       text default 'Monthly'
                     check (pay_schedule in ('Weekly','Biweekly','Semimonthly','Monthly','Per Project')),
  -- The official start date. NULL is a fact, not a guess: "Since Joining
  -- Larsa" falls back to all available history and the gap is queued for HR.
  employment_start   date,
  employment_end     date,
  start_date_source  text not null default 'unset'
                     check (start_date_source in ('unset','hr','payroll','imported')),
  base_salary        numeric(18,2) check (base_salary is null or base_salary >= 0),
  salary_currency    text not null default 'IQD' check (salary_currency in ('USD','IQD')),
  payment_method     text,
  payment_ref        text,                                -- masked before it ever leaves the server
  active             boolean not null default true,
  -- Company policy: may this employee see commissions that are still pending?
  show_pending_commissions boolean not null default true,
  is_sample          boolean not null default false,
  legacy_id          text unique,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. Payroll periods (runs).
-- ------------------------------------------------------------
create sequence if not exists public.pay_period_no_seq;
create sequence if not exists public.pay_slip_no_seq;

create table if not exists public.pay_periods (
  id               uuid primary key default gen_random_uuid(),
  period_no        text not null unique,                  -- LRS-PR-000001
  label            text,
  period_start     date not null,
  period_end       date not null,
  pay_date         date,
  region           text default 'Iraq',
  currency         text not null default 'IQD' check (currency in ('USD','IQD')),
  status           text not null default 'draft'
                   check (status in ('draft','pending_review','pending_approval','approved',
                                     'scheduled','partially_paid','paid','rejected','reversed','void')),
  -- Published = payslips are visible to employees. Approval alone is not
  -- publication: an approved run can still be corrected before it is shown.
  published_at     timestamptz,
  published_by     text,
  created_by_email text,
  created_by_name  text,
  submitted_at     timestamptz,
  submitted_by     text,
  approved_at      timestamptz,
  approved_by      text,
  decision_reason  text,
  note             text,                                   -- internal; never on a payslip
  is_sample        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (period_end >= period_start)
);

-- ------------------------------------------------------------
-- 3. Payroll items: one row per component per employee per period.
--    Amounts are always stored positive. pay_item_sign() decides whether a
--    type adds to or subtracts from net pay, so no caller can accidentally
--    flip a deduction into earnings by passing a negative number.
-- ------------------------------------------------------------
create table if not exists public.pay_items (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.pay_periods(id),
  employee_id       uuid not null references public.pay_employees(id),
  employee_email    text not null,
  item_type         text not null
                    check (item_type in ('base_salary','commission','bonus','allowance',
                                         'deduction','advance','advance_repayment','reimbursement')),
  description       text,
  source_ref        text,
  commission_id     uuid,
  -- historical exchange-rate snapshot, identical in shape to acct_transactions
  original_amount   numeric(18,2) not null check (original_amount >= 0),
  original_currency text not null check (original_currency in ('USD','IQD')),
  exchange_rate     numeric(14,6) not null check (exchange_rate > 0),
  rate_direction    text not null default 'USD_TO_IQD' check (rate_direction = 'USD_TO_IQD'),
  rate_date         date,
  rate_source       text not null default 'platform_default'
                    check (rate_source in ('platform_default','project_default','transaction_override','legacy_migrated')),
  rate_note         text,
  amount_iqd        numeric(18,2) not null,
  amount_usd        numeric(18,2) not null,
  -- the one-entry link into the accounting ledger
  txn_id            uuid references public.acct_transactions(id),
  posted_at         timestamptz,
  project_id        text references public.acct_projects(id),   -- optional cost allocation
  status            text not null default 'draft'
                    check (status in ('draft','pending_approval','approved','rejected','reversed','void')),
  meta              jsonb not null default '{}'::jsonb,
  is_sample         boolean not null default false,
  deleted_at        timestamptz,
  deleted_by        text,
  delete_reason     text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One payroll item, one ledger transaction. Enforced, not intended.
create unique index if not exists pay_items_txn_uq
  on public.pay_items (txn_id) where txn_id is not null;

-- ------------------------------------------------------------
-- 4. Commissions, with the full lifecycle and a frozen rule snapshot.
-- ------------------------------------------------------------
create table if not exists public.pay_commissions (
  id                uuid primary key default gen_random_uuid(),
  commission_no     text not null unique,                  -- LRS-CM-000001
  employee_id       uuid not null references public.pay_employees(id),
  employee_email    text not null,
  title             text not null,
  project_id        text references public.acct_projects(id),
  client            text,
  source_txn_id     uuid references public.acct_transactions(id),
  earning_start     date,
  earning_end       date,
  basis             text not null default 'percent' check (basis in ('percent','fixed')),
  rate              numeric(9,6) check (rate is null or (rate >= 0 and rate <= 1)),
  base_amount       numeric(18,2) check (base_amount is null or base_amount >= 0),
  base_currency     text check (base_currency is null or base_currency in ('USD','IQD')),
  -- The rule exactly as it stood when this commission was created. Changing
  -- a default later cannot reach back through this.
  rule_snapshot     jsonb not null default '{}'::jsonb,
  original_amount   numeric(18,2) not null check (original_amount >= 0),
  original_currency text not null check (original_currency in ('USD','IQD')),
  exchange_rate     numeric(14,6) not null check (exchange_rate > 0),
  rate_direction    text not null default 'USD_TO_IQD' check (rate_direction = 'USD_TO_IQD'),
  rate_date         date,
  rate_source       text not null default 'platform_default'
                    check (rate_source in ('platform_default','project_default','transaction_override','legacy_migrated')),
  amount_iqd        numeric(18,2) not null,
  amount_usd        numeric(18,2) not null,
  status            text not null default 'estimated'
                    check (status in ('estimated','pending_review','approved','scheduled','paid','rejected','reversed')),
  period_id         uuid references public.pay_periods(id),
  item_id           uuid references public.pay_items(id),
  submitted_at      timestamptz,
  submitted_by      text,
  approved_at       timestamptz,
  approved_by       text,
  paid_at           timestamptz,
  decision_reason   text,
  reverses_id       uuid references public.pay_commissions(id),
  -- Company policy per commission: is it shown to the employee before approval?
  visible_to_employee boolean not null default true,
  note              text,                                   -- internal
  is_sample         boolean not null default false,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5. Payments. A period can be paid in parts; each part is a row, and a
--    reversal is another row rather than an edit, so history stays readable.
-- ------------------------------------------------------------
create table if not exists public.pay_payments (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.pay_periods(id),
  employee_id       uuid not null references public.pay_employees(id),
  employee_email    text not null,
  paid_on           date not null,
  method            text,
  reference         text,
  original_amount   numeric(18,2) not null check (original_amount > 0),
  original_currency text not null check (original_currency in ('USD','IQD')),
  exchange_rate     numeric(14,6) not null check (exchange_rate > 0),
  rate_direction    text not null default 'USD_TO_IQD' check (rate_direction = 'USD_TO_IQD'),
  rate_date         date,
  rate_source       text not null default 'platform_default',
  amount_iqd        numeric(18,2) not null,
  amount_usd        numeric(18,2) not null,
  status            text not null default 'paid' check (status in ('paid','reversed')),
  reverses_id       uuid references public.pay_payments(id),
  reversal_reason   text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. Mapping queue: salary expenses that already exist in Accounting with
--    no payroll item behind them. Preserved exactly as they are; an
--    authorised accountant links them, nothing is guessed.
-- ------------------------------------------------------------
create table if not exists public.pay_mapping_queue (
  id             uuid primary key default gen_random_uuid(),
  txn_id         uuid not null unique references public.acct_transactions(id),
  reason         text not null default 'unlinked_salary_expense',
  suggested_email text,
  status         text not null default 'open' check (status in ('open','linked','dismissed')),
  resolved_by    text,
  resolved_at    timestamptz,
  resolution_note text,
  created_at     timestamptz not null default now()
);

-- HR gaps that must not be guessed — a missing employment start date is the
-- first one, because "Since Joining Larsa" depends on it.
create table if not exists public.pay_hr_queue (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.pay_employees(id),
  employee_email text not null,
  gap            text not null,
  status         text not null default 'open' check (status in ('open','resolved')),
  resolved_by    text,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (employee_id, gap)
);

create index if not exists pay_items_period_idx    on public.pay_items (period_id);
create index if not exists pay_items_employee_idx  on public.pay_items (employee_email, created_at desc);
create index if not exists pay_items_type_idx      on public.pay_items (item_type, status);
create index if not exists pay_comm_employee_idx   on public.pay_commissions (employee_email, created_at desc);
create index if not exists pay_comm_status_idx     on public.pay_commissions (status);
create index if not exists pay_pay_period_idx      on public.pay_payments (period_id);
create index if not exists pay_pay_employee_idx    on public.pay_payments (employee_email, paid_on desc);
create index if not exists pay_periods_range_idx   on public.pay_periods (period_start, period_end);

-- ------------------------------------------------------------
-- 7. Row-level security.
--    Deliberately stricter than the acct_* tables. Those grant select to any
--    authenticated session; payroll grants none. There is no policy that
--    permits a client to read a row, so no URL, export, REST call or crafted
--    query can reach one. Everything goes through the functions below.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pay_employees','pay_periods','pay_items','pay_commissions',
                           'pay_payments','pay_mapping_queue','pay_hr_queue']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "acct read" on public.%I', t);
    execute format('drop policy if exists "pay no direct read" on public.%I', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['pay_employees','pay_periods','pay_items','pay_commissions','pay_payments']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.acct_touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 8. Permissions.
--    Six new keys. Seeing your own pay needs none of them — that is what
--    My Pay is. Seeing anybody else's needs payroll_view_all, which no role
--    gets by accident: being an Organisation Administrator is not enough,
--    and neither is being a manager or a team leader.
-- ------------------------------------------------------------
create or replace function public.pay_permission_keys()
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$ select array['payroll_manage','payroll_approve','payroll_pay','payroll_view_all',
                   'payroll_publish','payroll_configure'] $$;

create or replace function public.acct_role_default_perms(p_role text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_role in ('Owner / Super Admin','Management') then
      array['view','create','edit_own_unapproved','edit_any_unapproved','submit_review','review','approve','reject',
            'print_receipts','reprint_receipts','post_refunds','approve_refunds','reopen_approved',
            'export_working','export_approved',
            'payroll_manage','payroll_approve','payroll_pay','payroll_view_all','payroll_publish','payroll_configure']
    when p_role = 'Accountant' then
      array['view','create','edit_own_unapproved','submit_review','print_receipts','reprint_receipts','post_refunds','export_working',
            'payroll_manage','payroll_view_all','payroll_pay','payroll_publish']
    when p_role = 'Payroll Accountant' then
      -- Enters and pays payroll, and sees the employee records needed to do
      -- it. Deliberately no payroll_approve: the person who prepares a run is
      -- not the person who approves it.
      array['view','export_working',
            'payroll_manage','payroll_view_all','payroll_pay','payroll_publish']
    when p_role in ('Project Manager','Construction Engineer') then
      array['view']
    else array['view']
  end;
$$;

create or replace function public.acct_get_my_permissions(p_email text, p_role text)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  g jsonb;
  base text[] := public.acct_role_default_perms(coalesce(p_role,''));
  all_perms text[] := array['view','create','edit_own_unapproved','edit_any_unapproved','submit_review','review','approve','reject',
    'print_receipts','reprint_receipts','post_refunds','approve_refunds','reopen_approved','export_working','export_approved','self_approve','manage_permissions']
    || public.pay_permission_keys();
  out jsonb := '{}'::jsonb;
  p text;
begin
  select grants into g from public.acct_permissions where email = lower(coalesce(p_email,''));
  foreach p in array all_perms loop
    out := out || jsonb_build_object(p,
      case when g is not null and g ? p then coalesce((g->>p)::boolean,false)
           else p = any (base) end);
  end loop;
  return out;
end;
$$;

-- ------------------------------------------------------------
-- 9. Small helpers.
-- ------------------------------------------------------------
create or replace function public.pay_item_sign(p_type text)
returns int
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p_type in ('deduction','advance_repayment') then -1 else 1 end;
$$;

-- Which item types are a company expense in their own right. Deductions and
-- advance repayments are not: they move money inside a net figure that has
-- already been costed. Advances are a balance-sheet movement, not a cost.
create or replace function public.pay_item_is_cost(p_type text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select p_type in ('base_salary','commission','bonus','allowance','reimbursement');
$$;

create or replace function public.pay_actor_email(actor jsonb)
returns text
language plpgsql stable
set search_path = public, pg_temp
as $$
declare e text := lower(trim(coalesce(actor->>'email','')));
begin
  if e = '' or position('@' in e) = 0 then
    raise exception 'ACCT_ACTOR: a valid actor email is required';
  end if;
  return e;
end;
$$;

create or replace function public.pay_can_view_all(actor jsonb)
returns boolean
language sql stable
security definer set search_path = public, pg_temp
as $$ select public.acct_has_perm(actor, 'payroll_view_all') $$;

-- Rate snapshot for a payroll amount. Payroll usually has no project, so this
-- falls back to the platform default — but it records WHICH default it used,
-- and the value, so a later change to that default cannot move this row.
create or replace function public.pay_resolve_rate(p_project_id text, p_override numeric default null)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare platform_rate numeric;
begin
  if p_override is not null and p_override > 0 then
    return jsonb_build_object('rate', p_override, 'source', 'transaction_override');
  end if;
  if p_project_id is not null then
    return public.acct_resolve_rate(p_project_id, null);
  end if;
  select default_exchange_rate into platform_rate from public.acct_platform_settings where id = 1;
  return jsonb_build_object('rate', coalesce(platform_rate, 1310), 'source', 'platform_default');
end;
$$;

-- The company project payroll costs are booked against. Client projects hold
-- client money; payroll is Larsa's own cost and must never land in a client's
-- fund control. Created once, lazily, with the consultancy fee waived so a
-- salary can never generate a client fee.
create or replace function public.pay_company_project()
returns text
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare pid text := 'prjlarsapayroll';
begin
  if not exists (select 1 from public.acct_projects where id = pid) then
    insert into public.acct_projects
      (id, code, name, client, region, type, status, currency,
       fee_inherit, fee_method, fee_rate, fee_basis, fee_treatment, created_by)
    values
      (pid, 'PAYROLL', 'Larsa Payroll & People', 'Larsa Engineering', 'Iraq', 'Company', 'Active', 'IQD',
       false, 'waived', 0, 'funding', 'project_expense', 'system');
  end if;
  return pid;
end;
$$;

-- ------------------------------------------------------------
-- 10. Employee records.
-- ------------------------------------------------------------
create or replace function public.pay_upsert_employee(actor jsonb, payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  e_email text := lower(trim(coalesce(payload->>'email','')));
  before_row public.pay_employees;
  row_emp public.pay_employees;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  if e_email = '' or position('@' in e_email) = 0 then
    raise exception 'ACCT_ACTOR: an employee email is required';
  end if;

  select * into before_row from public.pay_employees where email = e_email;

  insert into public.pay_employees
    (email, employee_no, full_name, position, department, region, employment_type, pay_schedule,
     employment_start, employment_end, start_date_source, base_salary, salary_currency,
     payment_method, payment_ref, active, show_pending_commissions, is_sample, legacy_id, created_by)
  values
    (e_email,
     nullif(payload->>'employee_no',''),
     coalesce(nullif(payload->>'full_name',''), e_email),
     nullif(payload->>'position',''),
     nullif(payload->>'department',''),
     coalesce(nullif(payload->>'region',''), 'Iraq'),
     coalesce(nullif(payload->>'employment_type',''), 'Employee'),
     coalesce(nullif(payload->>'pay_schedule',''), 'Monthly'),
     nullif(payload->>'employment_start','')::date,
     nullif(payload->>'employment_end','')::date,
     case when nullif(payload->>'employment_start','') is null then 'unset'
          else coalesce(nullif(payload->>'start_date_source',''), 'hr') end,
     nullif(payload->>'base_salary','')::numeric,
     coalesce(nullif(upper(payload->>'salary_currency'),''), 'IQD'),
     nullif(payload->>'payment_method',''),
     nullif(payload->>'payment_ref',''),
     coalesce((payload->>'active')::boolean, true),
     coalesce((payload->>'show_pending_commissions')::boolean, true),
     coalesce((payload->>'is_sample')::boolean, false),
     nullif(payload->>'legacy_id',''),
     a_email)
  on conflict (email) do update set
    employee_no      = coalesce(nullif(excluded.employee_no,''), public.pay_employees.employee_no),
    full_name        = coalesce(nullif(excluded.full_name,''), public.pay_employees.full_name),
    position         = coalesce(excluded.position, public.pay_employees.position),
    department       = coalesce(excluded.department, public.pay_employees.department),
    region           = coalesce(excluded.region, public.pay_employees.region),
    employment_type  = coalesce(excluded.employment_type, public.pay_employees.employment_type),
    pay_schedule     = coalesce(excluded.pay_schedule, public.pay_employees.pay_schedule),
    -- A known start date is never overwritten with a blank one.
    employment_start = coalesce(excluded.employment_start, public.pay_employees.employment_start),
    employment_end   = coalesce(excluded.employment_end, public.pay_employees.employment_end),
    start_date_source= case when excluded.employment_start is not null then excluded.start_date_source
                            else public.pay_employees.start_date_source end,
    base_salary      = coalesce(excluded.base_salary, public.pay_employees.base_salary),
    salary_currency  = coalesce(excluded.salary_currency, public.pay_employees.salary_currency),
    payment_method   = coalesce(excluded.payment_method, public.pay_employees.payment_method),
    payment_ref      = coalesce(excluded.payment_ref, public.pay_employees.payment_ref),
    active           = excluded.active,
    show_pending_commissions = excluded.show_pending_commissions
  returning * into row_emp;

  -- A missing start date is queued, never invented.
  if row_emp.employment_start is null then
    insert into public.pay_hr_queue (employee_id, employee_email, gap)
    values (row_emp.id, row_emp.email, 'employment_start_missing')
    on conflict (employee_id, gap) do nothing;
  else
    update public.pay_hr_queue set status = 'resolved', resolved_by = a_email, resolved_at = now()
     where employee_id = row_emp.id and gap = 'employment_start_missing' and status = 'open';
  end if;

  perform public.acct_log(actor, null, 'pay_employee', row_emp.id::text,
    case when before_row.id is null then 'Employee Record Created' else 'Employee Record Updated' end,
    nullif(payload->>'reason',''), null,
    case when before_row.id is null then null else to_jsonb(before_row) end,
    to_jsonb(row_emp), row_emp.email);

  return jsonb_build_object('ok', true, 'employee', to_jsonb(row_emp));
end;
$$;

-- ------------------------------------------------------------
-- 11. Periods and items.
-- ------------------------------------------------------------
create or replace function public.pay_open_period(actor jsonb, payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  row_period public.pay_periods;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');

  insert into public.pay_periods
    (period_no, label, period_start, period_end, pay_date, region, currency,
     created_by_email, created_by_name, note, is_sample)
  values
    ('LRS-PR-' || lpad(nextval('public.pay_period_no_seq')::text, 6, '0'),
     nullif(payload->>'label',''),
     (payload->>'period_start')::date,
     (payload->>'period_end')::date,
     nullif(payload->>'pay_date','')::date,
     coalesce(nullif(payload->>'region',''), 'Iraq'),
     coalesce(nullif(upper(payload->>'currency'),''), 'IQD'),
     a_email, actor->>'name', nullif(payload->>'note',''),
     coalesce((payload->>'is_sample')::boolean, false))
  returning * into row_period;

  perform public.acct_log(actor, null, 'pay_period', row_period.id::text, 'Payroll Period Opened',
    null, null, null, to_jsonb(row_period), row_period.period_no);

  return jsonb_build_object('ok', true, 'period', to_jsonb(row_period));
end;
$$;

create or replace function public.pay_add_item(actor jsonb, payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  per public.pay_periods;
  emp public.pay_employees;
  i_type text := lower(coalesce(payload->>'item_type',''));
  cur  text := upper(coalesce(payload->>'currency', payload->>'original_currency', ''));
  amt  numeric(18,2) := coalesce((payload->>'amount')::numeric, (payload->>'original_amount')::numeric);
  rate_res jsonb;
  rate numeric(14,6);
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  row_item public.pay_items;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');

  select * into per from public.pay_periods where id = (payload->>'period_id')::uuid;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if per.status in ('approved','scheduled','partially_paid','paid') then
    raise exception 'ACCT_IMMUTABLE: payroll period % is % — reopen or correct it through an adjustment', per.period_no, per.status;
  end if;

  select * into emp from public.pay_employees where email = lower(coalesce(payload->>'employee_email',''));
  if emp.id is null then raise exception 'ACCT_TXN: unknown employee "%"', payload->>'employee_email'; end if;

  if i_type not in ('base_salary','commission','bonus','allowance','deduction','advance','advance_repayment','reimbursement') then
    raise exception 'ACCT_TXN: unsupported payroll item type "%"', i_type;
  end if;
  if cur not in ('USD','IQD') then cur := per.currency; end if;
  if amt is null or amt < 0 then
    raise exception 'ACCT_TXN: amount must be zero or a positive number — the item type decides the sign';
  end if;

  rate_res := public.pay_resolve_rate(nullif(payload->>'project_id',''), nullif(payload->>'exchange_rate','')::numeric);
  rate := (rate_res->>'rate')::numeric;
  if cur = 'IQD' then
    a_iqd := round(amt, 2); a_usd := round(amt / rate, 2);
  else
    a_usd := round(amt, 2); a_iqd := round(amt * rate, 2);
  end if;

  insert into public.pay_items
    (period_id, employee_id, employee_email, item_type, description, source_ref, commission_id,
     original_amount, original_currency, exchange_rate, rate_date, rate_source, rate_note,
     amount_iqd, amount_usd, project_id, status, meta, is_sample, created_by)
  values
    (per.id, emp.id, emp.email, i_type, nullif(payload->>'description',''), nullif(payload->>'source_ref',''),
     nullif(payload->>'commission_id','')::uuid,
     amt, cur, rate, coalesce(nullif(payload->>'rate_date','')::date, per.pay_date, per.period_end),
     rate_res->>'source', nullif(payload->>'rate_note',''),
     a_iqd, a_usd, nullif(payload->>'project_id',''), 'draft',
     coalesce(payload->'meta', '{}'::jsonb), per.is_sample, a_email)
  returning * into row_item;

  perform public.acct_log(actor, row_item.project_id, 'pay_item', row_item.id::text, 'Payroll Item Added',
    null, null, null, to_jsonb(row_item), per.period_no || ' · ' || emp.email || ' · ' || i_type);

  return jsonb_build_object('ok', true, 'item', to_jsonb(row_item));
end;
$$;

create or replace function public.pay_submit_period(actor jsonb, p_period_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  per public.pay_periods;
  before_row public.pay_periods;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  select * into before_row from public.pay_periods where id = p_period_id;
  if before_row.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if before_row.status not in ('draft','pending_review','rejected') then
    raise exception 'ACCT_IMMUTABLE: payroll period % is already %', before_row.period_no, before_row.status;
  end if;

  update public.pay_periods
     set status = 'pending_approval', submitted_at = now(), submitted_by = a_email,
         note = coalesce(p_note, note)
   where id = p_period_id
  returning * into per;

  update public.pay_items set status = 'pending_approval'
   where period_id = p_period_id and deleted_at is null and status = 'draft';

  perform public.acct_log(actor, null, 'pay_period', per.id::text, 'Payroll Submitted For Approval',
    p_note, null, to_jsonb(before_row), to_jsonb(per), per.period_no);

  return jsonb_build_object('ok', true, 'period', to_jsonb(per));
end;
$$;

-- ------------------------------------------------------------
-- 12. Approval — and the one-entry posting into the accounting ledger.
--     Separation of duties is enforced on two axes: you cannot approve a run
--     you submitted, and you cannot approve a run that pays you.
-- ------------------------------------------------------------
create or replace function public.pay_decide_period(actor jsonb, p_period_id uuid, p_decision text, p_reason text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  before_row public.pay_periods;
  per public.pay_periods;
  it record;
  pid text;
  posted int := 0;
  txn_res jsonb;
  beneficiary boolean;
begin
  perform public.acct_check_perm(actor, 'payroll_approve');
  select * into before_row from public.pay_periods where id = p_period_id;
  if before_row.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if before_row.status <> 'pending_approval' then
    raise exception 'ACCT_APPROVAL: payroll period % is % — only a submitted run can be decided', before_row.period_no, before_row.status;
  end if;

  -- You cannot approve what you prepared.
  if lower(coalesce(before_row.submitted_by,'')) = a_email
     or lower(coalesce(before_row.created_by_email,'')) = a_email then
    if not public.acct_has_perm(actor, 'self_approve') then
      raise exception 'ACCT_APPROVAL: you submitted % — a different authorised user must approve it', before_row.period_no;
    end if;
  end if;

  -- You cannot approve a run that pays you.
  select exists (select 1 from public.pay_items
                  where period_id = p_period_id and deleted_at is null
                    and lower(employee_email) = a_email) into beneficiary;
  if beneficiary and not public.acct_has_perm(actor, 'self_approve') then
    raise exception 'ACCT_APPROVAL: % includes your own pay — a different authorised user must approve it', before_row.period_no;
  end if;

  if lower(coalesce(p_decision,'')) = 'reject' then
    update public.pay_periods
       set status = 'rejected', approved_at = now(), approved_by = a_email, decision_reason = p_reason
     where id = p_period_id returning * into per;
    update public.pay_items set status = 'rejected' where period_id = p_period_id and deleted_at is null;
    update public.pay_commissions set status = 'approved', period_id = null, item_id = null
     where period_id = p_period_id and status = 'scheduled';
    perform public.acct_log(actor, null, 'pay_period', per.id::text, 'Payroll Rejected',
      p_reason, null, to_jsonb(before_row), to_jsonb(per), per.period_no);
    return jsonb_build_object('ok', true, 'period', to_jsonb(per), 'posted', 0);
  end if;

  update public.pay_periods
     set status = 'approved', approved_at = now(), approved_by = a_email, decision_reason = p_reason
   where id = p_period_id returning * into per;
  update public.pay_items set status = 'approved' where period_id = p_period_id and deleted_at is null and status <> 'rejected';

  -- ---- one entry, not two ----
  -- Every costed item becomes exactly one accounting expense. Items that
  -- already carry a txn_id are skipped, so approving twice, replaying a
  -- request or re-running a migration cannot double-count a salary.
  pid := public.pay_company_project();
  perform set_config('acct.internal_op', '1', true);
  for it in
    select * from public.pay_items
     where period_id = p_period_id and deleted_at is null
       and status = 'approved' and txn_id is null
       and public.pay_item_is_cost(item_type)
       and original_amount > 0
  loop
    txn_res := public.acct_post_transaction(actor, jsonb_build_object(
      'kind', 'expense',
      'project_id', coalesce(it.project_id, pid),
      'category', case when it.item_type = 'reimbursement' then 'Reimbursement' else 'Payroll' end,
      'description', coalesce(it.description, initcap(replace(it.item_type,'_',' '))) || ' — ' || it.employee_email || ' (' || per.period_no || ')',
      'amount', it.original_amount,
      'currency', it.original_currency,
      'exchange_rate', it.exchange_rate,
      'rate_date', it.rate_date,
      'rate_note', 'Payroll snapshot ' || per.period_no,
      'status', 'approved',
      'date', coalesce(per.pay_date, per.period_end),
      'payment_source', 'Larsa Operating',
      'is_sample', per.is_sample,
      'external_ref', 'PAYITEM-' || it.id::text,
      'meta', jsonb_build_object(
        'cost_bearer', 'larsa',
        'payroll_item_id', it.id,
        'payroll_period', per.period_no,
        'payroll_item_type', it.item_type,
        'employee_email', it.employee_email)));

    update public.pay_items
       set txn_id = (txn_res#>>'{txn,id}')::uuid, posted_at = now()
     where id = it.id;
    posted := posted + 1;
  end loop;
  perform set_config('acct.internal_op', '', true);

  update public.pay_commissions
     set status = 'scheduled'
   where period_id = p_period_id and status in ('approved','pending_review','estimated');

  perform public.acct_log(actor, null, 'pay_period', per.id::text, 'Payroll Approved',
    p_reason, null, to_jsonb(before_row), to_jsonb(per),
    per.period_no || ' · ' || posted::text || ' ledger entries posted');

  return jsonb_build_object('ok', true, 'period', to_jsonb(per), 'posted', posted);
end;
$$;

create or replace function public.pay_publish_period(actor jsonb, p_period_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  per public.pay_periods;
begin
  perform public.acct_check_perm(actor, 'payroll_publish');
  select * into per from public.pay_periods where id = p_period_id;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if per.status not in ('approved','scheduled','partially_paid','paid') then
    raise exception 'ACCT_APPROVAL: % is % — only an approved run can be published to employees', per.period_no, per.status;
  end if;
  update public.pay_periods set published_at = coalesce(published_at, now()), published_by = a_email
   where id = p_period_id returning * into per;
  perform public.acct_log(actor, null, 'pay_period', per.id::text, 'Payslips Published',
    null, null, null, to_jsonb(per), per.period_no);
  return jsonb_build_object('ok', true, 'period', to_jsonb(per));
end;
$$;

-- ------------------------------------------------------------
-- 13. Payment, partial payment and reversal.
-- ------------------------------------------------------------
create or replace function public.pay_period_recompute(p_period_id uuid)
returns text
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  net_iqd numeric(18,2);
  paid_iqd numeric(18,2);
  st text;
  cur_status text;
begin
  select coalesce(sum(public.pay_item_sign(item_type) * amount_iqd), 0) into net_iqd
    from public.pay_items where period_id = p_period_id and deleted_at is null and status = 'approved';
  select coalesce(sum(case when status = 'paid' then amount_iqd else 0 end), 0) into paid_iqd
    from public.pay_payments where period_id = p_period_id;
  select status into cur_status from public.pay_periods where id = p_period_id;
  if cur_status in ('draft','pending_review','pending_approval','rejected','void') then
    return cur_status;
  end if;
  if paid_iqd <= 0 then
    st := 'approved';
  elsif paid_iqd + 0.01 < net_iqd then
    st := 'partially_paid';
  else
    st := 'paid';
  end if;
  update public.pay_periods set status = st where id = p_period_id;
  return st;
end;
$$;

create or replace function public.pay_record_payment(actor jsonb, payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  per public.pay_periods;
  emp public.pay_employees;
  cur text := upper(coalesce(payload->>'currency', payload->>'original_currency',''));
  amt numeric(18,2) := coalesce((payload->>'amount')::numeric, (payload->>'original_amount')::numeric);
  rate_res jsonb;
  rate numeric(14,6);
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  row_pay public.pay_payments;
  new_status text;
begin
  perform public.acct_check_perm(actor, 'payroll_pay');
  select * into per from public.pay_periods where id = (payload->>'period_id')::uuid;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if per.status not in ('approved','scheduled','partially_paid','paid') then
    raise exception 'ACCT_APPROVAL: % is % — a payment can only be recorded against an approved run', per.period_no, per.status;
  end if;
  select * into emp from public.pay_employees where email = lower(coalesce(payload->>'employee_email',''));
  if emp.id is null then raise exception 'ACCT_TXN: unknown employee "%"', payload->>'employee_email'; end if;
  if amt is null or amt <= 0 then raise exception 'ACCT_TXN: a payment amount must be a positive number'; end if;
  if cur not in ('USD','IQD') then cur := per.currency; end if;

  rate_res := public.pay_resolve_rate(null, nullif(payload->>'exchange_rate','')::numeric);
  rate := (rate_res->>'rate')::numeric;
  if cur = 'IQD' then a_iqd := round(amt,2); a_usd := round(amt / rate, 2);
  else a_usd := round(amt,2); a_iqd := round(amt * rate, 2); end if;

  insert into public.pay_payments
    (period_id, employee_id, employee_email, paid_on, method, reference,
     original_amount, original_currency, exchange_rate, rate_date, rate_source,
     amount_iqd, amount_usd, created_by)
  values
    (per.id, emp.id, emp.email,
     coalesce(nullif(payload->>'paid_on','')::date, current_date),
     nullif(payload->>'method',''), nullif(payload->>'reference',''),
     amt, cur, rate, coalesce(nullif(payload->>'rate_date','')::date, current_date), rate_res->>'source',
     a_iqd, a_usd, a_email)
  returning * into row_pay;

  new_status := public.pay_period_recompute(per.id);

  perform public.acct_log(actor, null, 'pay_payment', row_pay.id::text, 'Payroll Payment Recorded',
    nullif(payload->>'reason',''), null, null, to_jsonb(row_pay),
    per.period_no || ' · ' || emp.email);

  return jsonb_build_object('ok', true, 'payment', to_jsonb(row_pay), 'period_status', new_status);
end;
$$;

create or replace function public.pay_reverse_payment(actor jsonb, p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  src public.pay_payments;
  row_pay public.pay_payments;
  new_status text;
begin
  perform public.acct_check_perm(actor, 'payroll_pay');
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'ACCT_TXN: a reversal needs a reason';
  end if;
  select * into src from public.pay_payments where id = p_payment_id;
  if src.id is null then raise exception 'ACCT_TXN: unknown payment'; end if;
  if src.status = 'reversed' then raise exception 'ACCT_IMMUTABLE: that payment is already reversed'; end if;

  -- The original stays. The correction is a second row, so the employee's
  -- history shows what happened rather than quietly losing a payment.
  update public.pay_payments set status = 'reversed', reversal_reason = p_reason where id = p_payment_id;
  insert into public.pay_payments
    (period_id, employee_id, employee_email, paid_on, method, reference,
     original_amount, original_currency, exchange_rate, rate_date, rate_source,
     amount_iqd, amount_usd, status, reverses_id, reversal_reason, created_by)
  values
    (src.period_id, src.employee_id, src.employee_email, current_date, src.method, src.reference,
     src.original_amount, src.original_currency, src.exchange_rate, src.rate_date, src.rate_source,
     -src.amount_iqd, -src.amount_usd, 'reversed', src.id, p_reason, a_email)
  returning * into row_pay;

  new_status := public.pay_period_recompute(src.period_id);

  perform public.acct_log(actor, null, 'pay_payment', src.id::text, 'Payroll Payment Reversed',
    p_reason, null, to_jsonb(src), to_jsonb(row_pay), src.employee_email);

  return jsonb_build_object('ok', true, 'reversal', to_jsonb(row_pay), 'period_status', new_status);
end;
$$;

-- ------------------------------------------------------------
-- 14. Commissions.
-- ------------------------------------------------------------
create or replace function public.pay_record_commission(actor jsonb, payload jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  emp public.pay_employees;
  basis text := lower(coalesce(payload->>'basis','percent'));
  rate_pct numeric(9,6) := nullif(payload->>'rate','')::numeric;
  base_amt numeric(18,2) := nullif(payload->>'base_amount','')::numeric;
  cur text := upper(coalesce(payload->>'currency', payload->>'original_currency',''));
  amt numeric(18,2);
  rate_res jsonb;
  fx numeric(14,6);
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  row_com public.pay_commissions;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  select * into emp from public.pay_employees where email = lower(coalesce(payload->>'employee_email',''));
  if emp.id is null then raise exception 'ACCT_TXN: unknown employee "%"', payload->>'employee_email'; end if;
  if basis not in ('percent','fixed') then raise exception 'ACCT_TXN: commission basis must be percent or fixed'; end if;

  if basis = 'percent' then
    if rate_pct is null or base_amt is null then
      raise exception 'ACCT_TXN: a percentage commission needs both a rate and a base value';
    end if;
    amt := round(base_amt * rate_pct, 2);
  else
    amt := round(coalesce(nullif(payload->>'amount','')::numeric, 0), 2);
  end if;
  if amt is null or amt < 0 then raise exception 'ACCT_TXN: a commission cannot be negative'; end if;
  if cur not in ('USD','IQD') then cur := coalesce(nullif(upper(payload->>'base_currency'),''), 'IQD'); end if;

  rate_res := public.pay_resolve_rate(nullif(payload->>'project_id',''), nullif(payload->>'exchange_rate','')::numeric);
  fx := (rate_res->>'rate')::numeric;
  if cur = 'IQD' then a_iqd := round(amt,2); a_usd := round(amt / fx, 2);
  else a_usd := round(amt,2); a_iqd := round(amt * fx, 2); end if;

  insert into public.pay_commissions
    (commission_no, employee_id, employee_email, title, project_id, client, source_txn_id,
     earning_start, earning_end, basis, rate, base_amount, base_currency, rule_snapshot,
     original_amount, original_currency, exchange_rate, rate_date, rate_source,
     amount_iqd, amount_usd, status, visible_to_employee, note, is_sample, created_by)
  values
    ('LRS-CM-' || lpad(nextval('public.pay_slip_no_seq')::text, 6, '0'),
     emp.id, emp.email,
     coalesce(nullif(payload->>'title',''), 'Commission'),
     nullif(payload->>'project_id',''), nullif(payload->>'client',''),
     nullif(payload->>'source_txn_id','')::uuid,
     nullif(payload->>'earning_start','')::date, nullif(payload->>'earning_end','')::date,
     basis, rate_pct, base_amt, nullif(upper(payload->>'base_currency'),''),
     -- The rule is frozen here. Later changes to commission defaults cannot
     -- reach a commission that already exists.
     jsonb_build_object('basis', basis, 'rate', rate_pct, 'base_amount', base_amt,
                        'base_currency', nullif(upper(payload->>'base_currency'),''),
                        'exchange_rate', fx, 'rate_source', rate_res->>'source',
                        'captured_at', now(), 'captured_by', a_email),
     amt, cur, fx, coalesce(nullif(payload->>'rate_date','')::date, current_date), rate_res->>'source',
     a_iqd, a_usd,
     coalesce(nullif(lower(payload->>'status'),''), 'pending_review'),
     coalesce((payload->>'visible_to_employee')::boolean, true),
     nullif(payload->>'note',''),
     coalesce((payload->>'is_sample')::boolean, false), a_email)
  returning * into row_com;

  perform public.acct_log(actor, row_com.project_id, 'pay_commission', row_com.id::text, 'Commission Recorded',
    null, null, null, to_jsonb(row_com), row_com.commission_no || ' · ' || emp.email);

  return jsonb_build_object('ok', true, 'commission', to_jsonb(row_com));
end;
$$;

create or replace function public.pay_decide_commission(actor jsonb, p_commission_id uuid, p_decision text, p_reason text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  before_row public.pay_commissions;
  row_com public.pay_commissions;
  decision text := lower(coalesce(p_decision,''));
begin
  perform public.acct_check_perm(actor, 'payroll_approve');
  select * into before_row from public.pay_commissions where id = p_commission_id;
  if before_row.id is null then raise exception 'ACCT_TXN: unknown commission'; end if;
  if before_row.status in ('paid','reversed') then
    raise exception 'ACCT_IMMUTABLE: % is % and can only be corrected by a reversal', before_row.commission_no, before_row.status;
  end if;
  -- The beneficiary never signs off their own commission.
  if lower(before_row.employee_email) = a_email and not public.acct_has_perm(actor, 'self_approve') then
    raise exception 'ACCT_APPROVAL: % is your own commission — a different authorised user must decide it', before_row.commission_no;
  end if;
  if lower(coalesce(before_row.created_by,'')) = a_email and not public.acct_has_perm(actor, 'self_approve') then
    raise exception 'ACCT_APPROVAL: you recorded % — a different authorised user must approve it', before_row.commission_no;
  end if;

  update public.pay_commissions
     set status = case when decision = 'approve' then 'approved' else 'rejected' end,
         approved_at = now(), approved_by = a_email, decision_reason = p_reason
   where id = p_commission_id returning * into row_com;

  perform public.acct_log(actor, row_com.project_id, 'pay_commission', row_com.id::text,
    case when decision = 'approve' then 'Commission Approved' else 'Commission Rejected' end,
    p_reason, null, to_jsonb(before_row), to_jsonb(row_com), row_com.commission_no);

  return jsonb_build_object('ok', true, 'commission', to_jsonb(row_com));
end;
$$;

-- Scheduling a commission into a payroll run creates the matching payroll
-- item, so the commission is costed once and only once — through the run.
create or replace function public.pay_schedule_commission(actor jsonb, p_commission_id uuid, p_period_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  com public.pay_commissions;
  per public.pay_periods;
  row_item public.pay_items;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  select * into com from public.pay_commissions where id = p_commission_id;
  if com.id is null then raise exception 'ACCT_TXN: unknown commission'; end if;
  if com.status <> 'approved' then
    raise exception 'ACCT_APPROVAL: % is % — only an approved commission can be scheduled into payroll', com.commission_no, com.status;
  end if;
  select * into per from public.pay_periods where id = p_period_id;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if per.status not in ('draft','pending_review') then
    raise exception 'ACCT_IMMUTABLE: payroll period % is % — schedule into an open run', per.period_no, per.status;
  end if;

  insert into public.pay_items
    (period_id, employee_id, employee_email, item_type, description, source_ref, commission_id,
     original_amount, original_currency, exchange_rate, rate_date, rate_source, rate_note,
     amount_iqd, amount_usd, project_id, status, is_sample, created_by)
  values
    (per.id, com.employee_id, com.employee_email, 'commission', com.title, com.commission_no, com.id,
     com.original_amount, com.original_currency, com.exchange_rate, com.rate_date, com.rate_source,
     'Commission snapshot ' || com.commission_no,
     com.amount_iqd, com.amount_usd, com.project_id, 'draft', com.is_sample, a_email)
  returning * into row_item;

  update public.pay_commissions
     set status = 'scheduled', period_id = per.id, item_id = row_item.id
   where id = p_commission_id;

  perform public.acct_log(actor, com.project_id, 'pay_commission', com.id::text, 'Commission Scheduled In Payroll',
    null, null, null, to_jsonb(row_item), com.commission_no || ' → ' || per.period_no);

  return jsonb_build_object('ok', true, 'item', to_jsonb(row_item));
end;
$$;

-- ------------------------------------------------------------
-- 15. Mapping queue for pre-existing salary expenses.
--     Nothing is guessed and nothing is duplicated: the original accounting
--     transaction is preserved untouched, and linking only records the
--     relationship that was missing.
-- ------------------------------------------------------------
create or replace function public.pay_scan_unlinked_salary(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  found int := 0;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  insert into public.pay_mapping_queue (txn_id, reason, suggested_email)
  select t.id, 'unlinked_salary_expense', nullif(t.meta->>'employee_email','')
    from public.acct_transactions t
   where t.deleted_at is null
     and t.kind in ('expense','labor')
     and (t.category ilike '%payroll%' or t.category ilike '%salary%' or t.category ilike '%wage%'
          or t.description ilike '%salary%' or t.description ilike '%payroll%')
     and not exists (select 1 from public.pay_items i where i.txn_id = t.id)
  on conflict (txn_id) do nothing;
  get diagnostics found = row_count;

  perform public.acct_log(actor, null, 'pay_mapping', 'scan', 'Payroll Mapping Scan',
    null, null, null, jsonb_build_object('queued', found), found::text || ' unlinked salary entries queued');

  return jsonb_build_object('ok', true, 'queued', found,
    'open', (select count(*) from public.pay_mapping_queue where status = 'open'));
end;
$$;

create or replace function public.pay_link_transaction(actor jsonb, p_txn_id uuid, p_employee_email text, p_period_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  t public.acct_transactions;
  emp public.pay_employees;
  per public.pay_periods;
  row_item public.pay_items;
begin
  perform public.acct_check_perm(actor, 'payroll_manage');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: unknown transaction'; end if;
  if exists (select 1 from public.pay_items where txn_id = p_txn_id) then
    raise exception 'ACCT_IMMUTABLE: % is already linked to a payroll item', t.txn_no;
  end if;
  select * into emp from public.pay_employees where email = lower(coalesce(p_employee_email,''));
  if emp.id is null then raise exception 'ACCT_TXN: unknown employee "%"', p_employee_email; end if;
  select * into per from public.pay_periods where id = p_period_id;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;

  -- The payroll item carries the ORIGINAL transaction's amounts and rate.
  -- Historical payroll is never recalculated at today's salary or rate.
  insert into public.pay_items
    (period_id, employee_id, employee_email, item_type, description, source_ref,
     original_amount, original_currency, exchange_rate, rate_date, rate_source, rate_note,
     amount_iqd, amount_usd, txn_id, posted_at, project_id, status, meta, is_sample, created_by)
  values
    (per.id, emp.id, emp.email, 'base_salary',
     coalesce(t.description, 'Mapped salary expense'), t.txn_no,
     t.original_amount, t.original_currency, t.exchange_rate, t.rate_date,
     case when t.rate_source in ('platform_default','project_default','transaction_override','legacy_migrated')
          then t.rate_source else 'legacy_migrated' end,
     'Mapped from ' || t.txn_no, t.amount_iqd, t.amount_usd, t.id, now(), t.project_id,
     case when per.status in ('approved','scheduled','partially_paid','paid') then 'approved' else 'draft' end,
     jsonb_build_object('mapped_from_txn', t.txn_no, 'mapped_by', a_email), t.is_sample, a_email)
  returning * into row_item;

  update public.pay_mapping_queue
     set status = 'linked', resolved_by = a_email, resolved_at = now(), resolution_note = p_note
   where txn_id = p_txn_id;

  perform public.acct_log(actor, t.project_id, 'pay_item', row_item.id::text, 'Historical Payroll Mapped',
    p_note, null, to_jsonb(t), to_jsonb(row_item), t.txn_no || ' → ' || emp.email);

  return jsonb_build_object('ok', true, 'item', to_jsonb(row_item));
end;
$$;

-- ------------------------------------------------------------
-- 16. THE employee read path.
--
--     One function answers My Pay. It resolves who is being asked about
--     BEFORE it reads anything, and a caller without payroll_view_all can
--     only ever resolve to themselves — passing somebody else's address
--     changes nothing. Looking at another person's pay is audited every
--     time, with no exception for administrators.
--
--     Only published runs and settled commissions reach an employee. A draft
--     is invisible; a pending amount is labelled pending and is never added
--     into anything called "paid".
-- ------------------------------------------------------------
create or replace function public.pay_resolve_subject(actor jsonb, p_employee_email text)
returns text
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  want text := lower(trim(coalesce(p_employee_email,'')));
begin
  if want = '' or want = a_email then
    return a_email;
  end if;
  if not public.pay_can_view_all(actor) then
    -- Not an error that leaks whether the address exists: the caller simply
    -- gets their own record, which is the only one they are entitled to.
    return a_email;
  end if;
  return want;
end;
$$;

create or replace function public.pay_my_statement(
  actor jsonb,
  p_from date default null,
  p_to date default null,
  p_employee_email text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  subject text := public.pay_resolve_subject(actor, p_employee_email);
  emp public.pay_employees;
  d_from date := p_from;
  d_to date := coalesce(p_to, current_date);
  show_pending boolean;
  periods jsonb := '[]'::jsonb;
  commissions jsonb := '[]'::jsonb;
  months jsonb := '[]'::jsonb;
  tot record;
  paid_row record;
  pend_row record;
  by_cur jsonb := '{}'::jsonb;
  cur_row record;
  period_count int := 0;
  start_note text := null;
begin
  select * into emp from public.pay_employees where email = subject;
  if emp.id is null then
    return jsonb_build_object('ok', true, 'found', false, 'employee_email', subject,
      'note', 'No payroll record is set up for this account yet.');
  end if;

  -- Another person's pay is a deliberate act and is written down.
  if subject <> a_email then
    perform public.acct_log(actor, null, 'pay_employee', emp.id::text, 'Employee Pay Viewed',
      null, null, null, jsonb_build_object('subject', subject, 'from', d_from, 'to', d_to), subject);
  end if;

  show_pending := emp.show_pending_commissions;

  -- "Since joining" uses the official start date, and only that. When it is
  -- missing the range simply opens up and the gap is already queued for HR.
  if d_from is null and coalesce(p_employee_email,'') = '' then
    d_from := emp.employment_start;
  end if;
  if emp.employment_start is null then
    start_note := 'Employment start date is not recorded — showing all available payroll history.';
  end if;

  -- ---- period rows (published only) ----
  select coalesce(jsonb_agg(x order by x->>'period_start' desc), '[]'::jsonb), count(*)
    into periods, period_count
  from (
    select jsonb_build_object(
      'period_id', p.id,
      'period_no', p.period_no,
      'label', p.label,
      'period_start', p.period_start,
      'period_end', p.period_end,
      'pay_date', p.pay_date,
      'currency', p.currency,
      'status', p.status,
      'published_at', p.published_at,
      'base_salary_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'base_salary'), 0),
      'commission_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'commission'), 0),
      'bonus_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type in ('bonus','allowance')), 0),
      'deduction_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'deduction'), 0),
      'advance_repayment_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'advance_repayment'), 0),
      'reimbursement_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'reimbursement'), 0),
      'net_iqd', coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_iqd), 0),
      'net_usd', coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_usd), 0),
      'paid_iqd', coalesce((select sum(pp.amount_iqd) from public.pay_payments pp
                             where pp.period_id = p.id and pp.employee_email = emp.email and pp.status = 'paid'), 0),
      'last_paid_on', (select max(pp.paid_on) from public.pay_payments pp
                        where pp.period_id = p.id and pp.employee_email = emp.email and pp.status = 'paid'),
      'currencies', (select coalesce(jsonb_agg(distinct i2.original_currency), '[]'::jsonb)
                       from public.pay_items i2
                      where i2.period_id = p.id and i2.employee_email = emp.email and i2.deleted_at is null),
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', i3.id, 'item_type', i3.item_type, 'description', i3.description,
                    'original_amount', i3.original_amount, 'original_currency', i3.original_currency,
                    'exchange_rate', i3.exchange_rate, 'rate_date', i3.rate_date, 'rate_source', i3.rate_source,
                    'amount_iqd', i3.amount_iqd, 'amount_usd', i3.amount_usd,
                    'sign', public.pay_item_sign(i3.item_type), 'status', i3.status)
                    order by i3.item_type), '[]'::jsonb)
                  from public.pay_items i3
                 where i3.period_id = p.id and i3.employee_email = emp.email
                   and i3.deleted_at is null and i3.status = 'approved')
    ) as x
    from public.pay_periods p
    join public.pay_items i on i.period_id = p.id and i.employee_email = emp.email
                           and i.deleted_at is null and i.status = 'approved'
   where p.published_at is not null
     and p.status in ('approved','scheduled','partially_paid','paid','reversed')
     and (d_from is null or p.period_end >= d_from)
     and p.period_start <= d_to
   group by p.id
  ) rows;

  -- ---- totals, in IQD-equivalent snapshots plus a per-currency split ----
  select
    coalesce(sum(i.amount_iqd) filter (where i.item_type = 'base_salary'), 0) as base_iqd,
    coalesce(sum(i.amount_iqd) filter (where i.item_type = 'commission'), 0) as comm_iqd,
    coalesce(sum(i.amount_iqd) filter (where i.item_type in ('bonus','allowance')), 0) as bonus_iqd,
    coalesce(sum(i.amount_iqd) filter (where i.item_type = 'deduction'), 0) as ded_iqd,
    coalesce(sum(i.amount_iqd) filter (where i.item_type = 'advance_repayment'), 0) as adv_iqd,
    coalesce(sum(i.amount_iqd) filter (where i.item_type = 'reimbursement'), 0) as reim_iqd,
    coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_iqd), 0) as net_iqd,
    coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_usd), 0) as net_usd
    into tot
    from public.pay_items i
    join public.pay_periods p on p.id = i.period_id
   where i.employee_email = emp.email and i.deleted_at is null and i.status = 'approved'
     and p.published_at is not null
     and (d_from is null or p.period_end >= d_from) and p.period_start <= d_to;

  select coalesce(sum(pp.amount_iqd), 0) as paid_iqd,
         coalesce(sum(pp.amount_usd), 0) as paid_usd,
         max(pp.paid_on) as last_paid
    into paid_row
    from public.pay_payments pp
    join public.pay_periods p on p.id = pp.period_id
   where pp.employee_email = emp.email and pp.status = 'paid'
     and p.published_at is not null
     and (d_from is null or p.period_end >= d_from) and p.period_start <= d_to;

  -- Currency split. USD and IQD are reported side by side and never summed
  -- into one number: the IQD figures above are historical snapshots, not a
  -- live conversion, and mixing the two would invent money.
  for cur_row in
    select i.original_currency as cur,
           sum(public.pay_item_sign(i.item_type) * i.original_amount) as net_original
      from public.pay_items i
      join public.pay_periods p on p.id = i.period_id
     where i.employee_email = emp.email and i.deleted_at is null and i.status = 'approved'
       and p.published_at is not null
       and (d_from is null or p.period_end >= d_from) and p.period_start <= d_to
     group by i.original_currency
  loop
    by_cur := by_cur || jsonb_build_object(cur_row.cur, jsonb_build_object('net', cur_row.net_original));
  end loop;

  -- ---- monthly series for the charts ----
  select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) into months
  from (
    select jsonb_build_object(
      'month', to_char(p.period_start, 'YYYY-MM'),
      'base_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'base_salary'), 0),
      'commission_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type = 'commission'), 0),
      'bonus_iqd', coalesce(sum(i.amount_iqd) filter (where i.item_type in ('bonus','allowance')), 0),
      'net_iqd', coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_iqd), 0)
    ) as m
    from public.pay_periods p
    join public.pay_items i on i.period_id = p.id and i.employee_email = emp.email
                           and i.deleted_at is null and i.status = 'approved'
   where p.published_at is not null
     and (d_from is null or p.period_end >= d_from) and p.period_start <= d_to
   group by to_char(p.period_start, 'YYYY-MM')
  ) mm;

  -- ---- commissions ----
  -- Pending ones appear only when policy allows it, and always carry their
  -- own status so they can never read as money already received.
  select coalesce(jsonb_agg(c order by c->>'created_at' desc), '[]'::jsonb) into commissions
  from (
    select jsonb_build_object(
      'id', c.id, 'commission_no', c.commission_no, 'title', c.title,
      'project_id', c.project_id, 'client', c.client,
      'earning_start', c.earning_start, 'earning_end', c.earning_end,
      'basis', c.basis, 'rate', c.rate, 'base_amount', c.base_amount, 'base_currency', c.base_currency,
      'rule_snapshot', c.rule_snapshot,
      'original_amount', c.original_amount, 'original_currency', c.original_currency,
      'exchange_rate', c.exchange_rate, 'rate_date', c.rate_date, 'rate_source', c.rate_source,
      'amount_iqd', c.amount_iqd, 'amount_usd', c.amount_usd,
      'status', c.status, 'submitted_at', c.submitted_at, 'approved_at', c.approved_at,
      'approved_by', c.approved_by, 'paid_at', c.paid_at,
      'period_no', (select p2.period_no from public.pay_periods p2 where p2.id = c.period_id),
      'reverses_id', c.reverses_id,
      'created_at', c.created_at
    ) as c
    from public.pay_commissions c
   where c.employee_email = emp.email
     and c.visible_to_employee
     and (c.status not in ('estimated','pending_review') or show_pending)
     and (d_from is null or coalesce(c.earning_end, c.created_at::date) >= d_from)
     and coalesce(c.earning_start, c.created_at::date) <= d_to
  ) cc;

  select coalesce(sum(c.amount_iqd) filter (where c.status in ('approved','scheduled','paid')), 0) as approved_iqd,
         coalesce(sum(c.amount_iqd) filter (where c.status in ('estimated','pending_review')), 0) as pending_iqd
    into pend_row
    from public.pay_commissions c
   where c.employee_email = emp.email and c.visible_to_employee
     and (d_from is null or coalesce(c.earning_end, c.created_at::date) >= d_from)
     and coalesce(c.earning_start, c.created_at::date) <= d_to;

  return jsonb_build_object(
    'ok', true,
    'found', true,
    'viewed_by_self', subject = a_email,
    'employee', jsonb_build_object(
      'email', emp.email, 'employee_no', emp.employee_no, 'full_name', emp.full_name,
      'position', emp.position, 'department', emp.department, 'region', emp.region,
      'employment_start', emp.employment_start, 'employment_type', emp.employment_type,
      'pay_schedule', emp.pay_schedule, 'salary_currency', emp.salary_currency,
      'base_salary', emp.base_salary,
      -- Never the raw account: only enough to recognise it.
      'payment_method', emp.payment_method,
      'payment_ref_masked', case when coalesce(emp.payment_ref,'') = '' then null
                                 else repeat('•', greatest(length(emp.payment_ref) - 4, 0)) || right(emp.payment_ref, 4) end,
      'show_pending_commissions', emp.show_pending_commissions),
    'range', jsonb_build_object('from', d_from, 'to', d_to, 'note', start_note),
    'totals', jsonb_build_object(
      'base_salary_iqd', tot.base_iqd,
      'commission_iqd', tot.comm_iqd,
      'bonus_iqd', tot.bonus_iqd,
      'deduction_iqd', tot.ded_iqd,
      'advance_repayment_iqd', tot.adv_iqd,
      'reimbursement_iqd', tot.reim_iqd,
      'net_iqd', tot.net_iqd,
      'net_usd', tot.net_usd,
      'paid_iqd', paid_row.paid_iqd,
      'paid_usd', paid_row.paid_usd,
      'outstanding_iqd', round(tot.net_iqd - paid_row.paid_iqd, 2),
      'approved_commission_iqd', pend_row.approved_iqd,
      'pending_commission_iqd', pend_row.pending_iqd,
      'periods', period_count,
      'average_month_iqd', case when period_count > 0 then round(tot.net_iqd / period_count, 2) else 0 end,
      'last_paid_on', paid_row.last_paid),
    'by_currency', by_cur,
    'periods', periods,
    'months', months,
    'commissions', commissions,
    'computed_at', now());
end;
$$;

-- ------------------------------------------------------------
-- 17. The payslip: an immutable snapshot of one published period.
--     Reproducible — it reads the stored amounts and stored rates, so the
--     same period downloaded next year shows the same figures.
-- ------------------------------------------------------------
create or replace function public.pay_payslip(actor jsonb, p_period_id uuid, p_employee_email text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := public.pay_actor_email(actor);
  subject text := public.pay_resolve_subject(actor, p_employee_email);
  emp public.pay_employees;
  per public.pay_periods;
  items jsonb;
  payments jsonb;
  net_iqd numeric(18,2);
  gross_iqd numeric(18,2);
  paid_iqd numeric(18,2);
begin
  select * into emp from public.pay_employees where email = subject;
  if emp.id is null then raise exception 'ACCT_TXN: no payroll record for this account'; end if;
  select * into per from public.pay_periods where id = p_period_id;
  if per.id is null then raise exception 'ACCT_TXN: unknown payroll period'; end if;
  if per.published_at is null and not public.pay_can_view_all(actor) then
    raise exception 'ACCT_APPROVAL: that payslip has not been published yet';
  end if;

  if subject <> a_email then
    perform public.acct_log(actor, null, 'pay_payslip', per.id::text, 'Payslip Downloaded',
      null, null, null, jsonb_build_object('subject', subject, 'period', per.period_no), subject);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_type', i.item_type, 'description', i.description,
           'original_amount', i.original_amount, 'original_currency', i.original_currency,
           'exchange_rate', i.exchange_rate, 'rate_date', i.rate_date, 'rate_source', i.rate_source,
           'amount_iqd', i.amount_iqd, 'amount_usd', i.amount_usd,
           'sign', public.pay_item_sign(i.item_type)) order by i.item_type, i.created_at), '[]'::jsonb),
         coalesce(sum(public.pay_item_sign(i.item_type) * i.amount_iqd), 0),
         coalesce(sum(i.amount_iqd) filter (where public.pay_item_sign(i.item_type) > 0), 0)
    into items, net_iqd, gross_iqd
    from public.pay_items i
   where i.period_id = per.id and i.employee_email = emp.email
     and i.deleted_at is null and i.status = 'approved';

  select coalesce(jsonb_agg(jsonb_build_object(
           'paid_on', pp.paid_on, 'amount', pp.original_amount, 'currency', pp.original_currency,
           'amount_iqd', pp.amount_iqd, 'status', pp.status,
           'method', pp.method,
           'reference_masked', case when coalesce(pp.reference,'') = '' then null
                                    else repeat('•', greatest(length(pp.reference) - 4, 0)) || right(pp.reference, 4) end,
           'reversal_reason', pp.reversal_reason) order by pp.paid_on), '[]'::jsonb),
         coalesce(sum(case when pp.status = 'paid' then pp.amount_iqd else 0 end), 0)
    into payments, paid_iqd
    from public.pay_payments pp
   where pp.period_id = per.id and pp.employee_email = emp.email;

  return jsonb_build_object(
    'ok', true,
    'slip_no', per.period_no || '-' || coalesce(emp.employee_no, right(emp.id::text, 6)),
    'verification', encode(digest(per.id::text || emp.id::text || per.period_no, 'sha256'), 'hex'),
    'employer', jsonb_build_object('name', 'Larsa Engineering'),
    'employee', jsonb_build_object(
      'email', emp.email, 'employee_no', emp.employee_no, 'full_name', emp.full_name,
      'position', emp.position, 'department', emp.department,
      'employment_start', emp.employment_start,
      'payment_method', emp.payment_method,
      'payment_ref_masked', case when coalesce(emp.payment_ref,'') = '' then null
                                 else repeat('•', greatest(length(emp.payment_ref) - 4, 0)) || right(emp.payment_ref, 4) end),
    'period', jsonb_build_object(
      'period_no', per.period_no, 'label', per.label,
      'period_start', per.period_start, 'period_end', per.period_end,
      'pay_date', per.pay_date, 'currency', per.currency, 'status', per.status,
      'published_at', per.published_at, 'approved_by', per.approved_by, 'approved_at', per.approved_at),
    'items', items,
    'payments', payments,
    'gross_iqd', gross_iqd,
    'net_iqd', net_iqd,
    'paid_iqd', paid_iqd,
    'outstanding_iqd', round(net_iqd - paid_iqd, 2),
    -- The document must never imply a payment that has not happened.
    'payment_state', case when paid_iqd <= 0 then 'approved_unpaid'
                          when paid_iqd + 0.01 < net_iqd then 'partially_paid'
                          else 'paid' end,
    'computed_at', now());
end;
$$;

-- ------------------------------------------------------------
-- 18. The accountant read path.
-- ------------------------------------------------------------
create or replace function public.pay_admin_overview(actor jsonb, p_limit int default 200)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare lim int := least(greatest(coalesce(p_limit,200),1),1000);
begin
  perform public.acct_check_perm(actor, 'payroll_view_all');
  return jsonb_build_object(
    'ok', true,
    'employees', (select coalesce(jsonb_agg(to_jsonb(e) order by e.full_name), '[]'::jsonb)
                    from public.pay_employees e),
    'periods', (select coalesce(jsonb_agg(to_jsonb(p) order by p.period_start desc), '[]'::jsonb)
                  from (select * from public.pay_periods order by period_start desc limit lim) p),
    'commissions', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
                      from (select * from public.pay_commissions order by created_at desc limit lim) c),
    'mapping_queue', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', q.id, 'txn_id', q.txn_id, 'status', q.status,
                        'suggested_email', q.suggested_email,
                        'txn_no', t.txn_no, 'description', t.description, 'category', t.category,
                        'amount', t.original_amount, 'currency', t.original_currency,
                        'amount_iqd', t.amount_iqd, 'txn_date', t.txn_date) order by t.txn_date desc), '[]'::jsonb)
                      from public.pay_mapping_queue q join public.acct_transactions t on t.id = q.txn_id
                     where q.status = 'open'),
    'hr_queue', (select coalesce(jsonb_agg(jsonb_build_object(
                    'employee_email', h.employee_email, 'gap', h.gap) ), '[]'::jsonb)
                   from public.pay_hr_queue h where h.status = 'open'),
    'computed_at', now());
end;
$$;

-- ------------------------------------------------------------
-- 19. Grants. Nothing here is callable by an anonymous caller, and the
--     internal helpers stay callable only from the definer functions above.
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'pay_upsert_employee(jsonb,jsonb)',
    'pay_open_period(jsonb,jsonb)',
    'pay_add_item(jsonb,jsonb)',
    'pay_submit_period(jsonb,uuid,text)',
    'pay_decide_period(jsonb,uuid,text,text)',
    'pay_publish_period(jsonb,uuid)',
    'pay_record_payment(jsonb,jsonb)',
    'pay_reverse_payment(jsonb,uuid,text)',
    'pay_record_commission(jsonb,jsonb)',
    'pay_decide_commission(jsonb,uuid,text,text)',
    'pay_schedule_commission(jsonb,uuid,uuid)',
    'pay_scan_unlinked_salary(jsonb)',
    'pay_link_transaction(jsonb,uuid,text,uuid,text)',
    'pay_my_statement(jsonb,date,date,text)',
    'pay_payslip(jsonb,uuid,text)',
    'pay_admin_overview(jsonb,int)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;

  revoke all on function public.pay_period_recompute(uuid) from public, anon, authenticated;
  revoke all on function public.pay_company_project() from public, anon, authenticated;
  revoke all on function public.pay_resolve_subject(jsonb,text) from public, anon, authenticated;
  revoke all on function public.pay_resolve_rate(text,numeric) from public, anon, authenticated;
  revoke all on function public.pay_actor_email(jsonb) from public, anon, authenticated;

  revoke all on function public.pay_can_view_all(jsonb) from public, anon;
  grant execute on function public.pay_can_view_all(jsonb) to authenticated;
  revoke all on function public.pay_item_sign(text) from public, anon;
  grant execute on function public.pay_item_sign(text) to authenticated;
  revoke all on function public.pay_item_is_cost(text) from public, anon;
  grant execute on function public.pay_item_is_cost(text) to authenticated;
  revoke all on function public.pay_permission_keys() from public, anon;
  grant execute on function public.pay_permission_keys() to authenticated;
exception when others then null;
end;
$$;
