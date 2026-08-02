-- ============================================================
-- Larsa Control — Accounting upgrade, part 1: core tables
--
-- Additive and backward-compatible. Nothing existing is renamed,
-- dropped, or rewritten: app_state (the legacy JSON blob sync) keeps
-- working exactly as before. These tables become the AUTHORITATIVE
-- accounting store; the blob remains a cache for non-accounting
-- modules and offline fallback.
--
-- Financial amounts use numeric(18,2); exchange rates numeric(14,6);
-- percentages numeric(9,6). All timestamps are timestamptz (UTC).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Platform-level accounting settings (singleton)
-- ------------------------------------------------------------
create table if not exists public.acct_platform_settings (
  id                     integer primary key default 1 check (id = 1),
  -- Exchange-rate platform default, direction: 1 USD = X IQD
  default_exchange_rate  numeric(14,6) not null default 1310 check (default_exchange_rate > 0),
  rate_direction         text not null default 'USD_TO_IQD' check (rate_direction = 'USD_TO_IQD'),
  -- Consultancy-fee platform default: 8%, percentage on funding,
  -- deducted from funding. Editable by the Platform Super Admin only.
  default_fee_method     text not null default 'percentage'
                         check (default_fee_method in ('percentage','fixed_per_project','fixed_per_transaction','waived')),
  default_fee_rate       numeric(9,6) not null default 0.08 check (default_fee_rate >= 0 and default_fee_rate <= 1),
  default_fee_fixed      numeric(18,2) not null default 0 check (default_fee_fixed >= 0),
  default_fee_basis      text not null default 'funding'
                         check (default_fee_basis in ('funding','income','total_expenses','materials_only','labor_only','expense_categories','custom')),
  default_fee_basis_categories text[] not null default '{}',
  default_fee_treatment  text not null default 'deduct_from_funding'
                         check (default_fee_treatment in ('deduct_from_funding','project_expense','larsa_revenue','custom')),
  -- Sample-data lifecycle: seeded once for an empty organization,
  -- never re-seeded after removal.
  sample_state           text not null default 'never_seeded'
                         check (sample_state in ('never_seeded','seeded','removed')),
  sample_seeded_at       timestamptz,
  sample_removed_at      timestamptz,
  display_timezone       text not null default 'Asia/Baghdad',
  updated_at             timestamptz not null default now(),
  updated_by             text
);

insert into public.acct_platform_settings (id) values (1)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. Execution projects (accounting registry)
--    id is text so legacy blob project ids ("prj...") keep working.
-- ------------------------------------------------------------
create table if not exists public.acct_projects (
  id                      text primary key,
  code                    text,
  name                    text not null,
  client                  text,
  region                  text default 'Iraq',
  type                    text default 'Construction',
  status                  text not null default 'Active',
  currency                text not null default 'IQD' check (currency in ('USD','IQD')),
  contract_value          numeric(18,2) check (contract_value is null or contract_value >= 0),
  approved_budget         numeric(18,2) check (approved_budget is null or approved_budget >= 0),
  budget_currency         text check (budget_currency is null or budget_currency in ('USD','IQD')),
  -- Project default exchange rate. NULL = inherit platform default.
  default_exchange_rate   numeric(14,6) check (default_exchange_rate is null or default_exchange_rate > 0),
  -- Project default consultancy-fee rule. fee_inherit=true = inherit platform.
  fee_inherit             boolean not null default true,
  fee_method              text check (fee_method is null or fee_method in ('percentage','fixed_per_project','fixed_per_transaction','waived')),
  fee_rate                numeric(9,6) check (fee_rate is null or (fee_rate >= 0 and fee_rate <= 1)),
  fee_fixed               numeric(18,2) check (fee_fixed is null or fee_fixed >= 0),
  fee_basis               text check (fee_basis is null or fee_basis in ('funding','income','total_expenses','materials_only','labor_only','expense_categories','custom')),
  fee_basis_categories    text[] not null default '{}',
  fee_treatment           text check (fee_treatment is null or fee_treatment in ('deduct_from_funding','project_expense','larsa_revenue','custom')),
  -- Per-category fee overrides: [{"category":"Steel","method":"percentage","rate":0.05,...}]
  fee_category_overrides  jsonb not null default '[]'::jsonb,
  is_sample               boolean not null default false,
  archived_at             timestamptz,
  archive_reason          text,
  legacy_id               text unique,
  created_by              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. The single authoritative accounting transaction ledger.
--    One row per financial event: funding, material, labor, expense,
--    revenue, refund, adjustment, reversal. Materials and Labor are
--    transactions here — never double-entered under Expenses.
-- ------------------------------------------------------------
create sequence if not exists public.acct_txn_no_seq;
create sequence if not exists public.acct_receipt_no_seq;

create table if not exists public.acct_transactions (
  id                  uuid primary key default gen_random_uuid(),
  txn_no              text not null unique,             -- server-generated: LRS-TXN-000001
  receipt_no          text unique,                      -- server-generated when receipted
  project_id          text not null references public.acct_projects(id),
  kind                text not null check (kind in ('funding','material','labor','expense','revenue','refund','adjustment','reversal')),
  category            text,
  description         text,
  supplier            text,
  quantity            numeric(18,3),
  unit                text,
  txn_date            date not null,
  status              text not null default 'draft'
                      check (status in ('draft','pending','approved','posted','received','paid','rejected','void','reversed')),
  payment_source      text,                             -- 'Client Funding' | 'Larsa Operating' | ...
  -- ---- historical exchange-rate snapshot (immutable once posted) ----
  original_amount     numeric(18,2) not null,
  original_currency   text not null check (original_currency in ('USD','IQD')),
  exchange_rate       numeric(14,6) not null check (exchange_rate > 0),
  rate_direction      text not null default 'USD_TO_IQD' check (rate_direction = 'USD_TO_IQD'),
  rate_date           date,
  rate_source         text not null default 'project_default'
                      check (rate_source in ('platform_default','project_default','transaction_override','legacy_migrated')),
  rate_note           text,
  rate_confirmed_by   text,
  amount_iqd          numeric(18,2) not null,           -- historical IQD equivalent snapshot
  amount_usd          numeric(18,2) not null,           -- historical USD equivalent snapshot
  -- ---- consultancy-fee rule snapshot applied to THIS transaction ----
  fee_rule            jsonb,                            -- {method,rate,fixed,basis,basis_categories,treatment,source,waived,waiver_reason}
  -- ---- lifecycle / integrity ----
  is_sample           boolean not null default false,
  client_key          uuid unique,                      -- idempotency key from the client (double-submit guard)
  external_ref        text,                             -- invoice / reference number
  attachment_path     text,                             -- private storage path for the receipt
  deleted_at          timestamptz,                      -- soft delete (drafts only)
  deleted_by          text,
  delete_reason       text,
  void_reason         text,
  reversal_of         uuid references public.acct_transactions(id),
  reversed_by_txn     uuid references public.acct_transactions(id),
  legacy_id           text unique,                      -- blob record id, set by the legacy importer
  legacy_collection   text,                             -- funding|materials|projectLabor|expenses|revenue
  meta                jsonb not null default '{}'::jsonb,
  created_by_email    text,
  created_by_name     text,
  created_by_role     text,
  approved_by         text,
  approved_at         timestamptz,
  posted_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists acct_txn_project_idx  on public.acct_transactions (project_id, kind, status);
create index if not exists acct_txn_date_idx     on public.acct_transactions (txn_date);
create index if not exists acct_txn_sample_idx   on public.acct_transactions (is_sample) where is_sample;
-- One live transaction per external reference per project+kind (duplicate invoice guard)
create unique index if not exists acct_txn_extref_uq on public.acct_transactions (project_id, kind, external_ref)
  where external_ref is not null and external_ref <> '' and status not in ('void','rejected','reversed') and deleted_at is null;

-- ------------------------------------------------------------
-- 4. Consultancy-fee ledger. Every generated fee, adjustment, and
--    reversal. A partial unique index makes fee posting idempotent:
--    one live fee entry per source transaction, ever.
-- ------------------------------------------------------------
create table if not exists public.acct_fee_ledger (
  id                  uuid primary key default gen_random_uuid(),
  project_id          text not null references public.acct_projects(id),
  source_txn_id       uuid references public.acct_transactions(id),
  entry_type          text not null default 'fee'
                      check (entry_type in ('fee','fee_reversal','fee_adjustment')),
  calc_method         text not null check (calc_method in ('percentage','fixed_per_project','fixed_per_transaction','waived')),
  fee_rate            numeric(9,6),
  fixed_amount        numeric(18,2),
  calc_basis          text not null,
  basis_amount        numeric(18,2) not null default 0,   -- eligible base amount (original currency)
  fee_amount          numeric(18,2) not null default 0,   -- in `currency` (source txn currency unless noted)
  currency            text not null check (currency in ('USD','IQD')),
  exchange_rate       numeric(14,6) not null check (exchange_rate > 0),
  rate_direction      text not null default 'USD_TO_IQD',
  fee_iqd             numeric(18,2) not null default 0,
  fee_usd             numeric(18,2) not null default 0,
  treatment           text not null check (treatment in ('deduct_from_funding','project_expense','larsa_revenue','custom')),
  config_source       text not null default 'project_default'
                      check (config_source in ('platform_default','project_default','category_override','transaction_override','legacy')),
  status              text not null default 'estimated'
                      check (status in ('estimated','posted','settled','reversed','void')),
  provisional         boolean not null default false,     -- funding-based fees stay provisional until settled
  waived              boolean not null default false,
  waiver_reason       text,
  is_sample           boolean not null default false,
  refund_settlement_id uuid,                              -- set on reversal entries created by a refund
  reversal_of         uuid references public.acct_fee_ledger(id),
  adjusts             uuid references public.acct_fee_ledger(id),
  note                text,
  created_by          text,
  approved_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists acct_fee_project_idx on public.acct_fee_ledger (project_id, status);
-- Idempotency: one live 'fee' entry per source transaction.
create unique index if not exists acct_fee_source_uq on public.acct_fee_ledger (source_txn_id)
  where entry_type = 'fee' and status in ('estimated','posted','settled');
-- One live fixed-per-project fee per project.
create unique index if not exists acct_fee_fixed_project_uq on public.acct_fee_ledger (project_id)
  where entry_type = 'fee' and calc_method = 'fixed_per_project' and status in ('estimated','posted','settled');

-- ------------------------------------------------------------
-- 5. Refund settlements (unused funding returned to the client).
-- ------------------------------------------------------------
create table if not exists public.acct_refund_settlements (
  id                    uuid primary key default gen_random_uuid(),
  project_id            text not null references public.acct_projects(id),
  status                text not null default 'draft'
                        check (status in ('draft','pending_approval','approved','posted','rejected','cancelled')),
  -- The Larsa rule, snapshotted at computation time:
  --   unused_net       = initial net construction funding − approved/posted project expenses
  --   refundable_fee   = unused_net × original snapshotted consultancy rate (per funding entry)
  --   total_refund     = unused_net + refundable_fee
  --   retained_fee     = initial fee − refundable fee
  currency              text not null check (currency in ('USD','IQD')),
  unused_net_funding    numeric(18,2) not null default 0,
  refundable_fee        numeric(18,2) not null default 0,
  total_refund          numeric(18,2) not null default 0,
  initial_fee           numeric(18,2) not null default 0,
  retained_fee          numeric(18,2) not null default 0,
  partial               boolean not null default false,
  refund_amount_requested numeric(18,2),                  -- for partial refunds: the unused amount being returned
  allocations           jsonb not null default '[]'::jsonb, -- [{funding_txn_id, allocated_unused, fee_rate, refundable_fee, exchange_rate, currency}]
  allocation_method     text not null default 'FIFO' check (allocation_method in ('FIFO','manual')),
  settlement_rate       numeric(14,6),                    -- exchange rate actually used to pay, if different
  settlement_currency   text check (settlement_currency in ('USD','IQD')),
  fx_gain_loss_iqd      numeric(18,2) not null default 0,
  excess_fee_refund     numeric(18,2) not null default 0, -- expense-based projects: over-collected fee added to refund
  computed_at           timestamptz not null default now(),
  reason                text,
  approval_request_id   uuid,
  refund_txn_id         uuid references public.acct_transactions(id),
  fx_adjustment_txn_id  uuid references public.acct_transactions(id),
  is_sample             boolean not null default false,
  created_by            text,
  posted_by             text,
  posted_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists acct_refund_project_idx on public.acct_refund_settlements (project_id, status);

-- ------------------------------------------------------------
-- 6. Schedule / physical progress history (append-only).
-- ------------------------------------------------------------
create table if not exists public.acct_progress_updates (
  id            uuid primary key default gen_random_uuid(),
  project_id    text not null references public.acct_projects(id),
  percent       numeric(5,2) not null check (percent >= 0 and percent <= 100),
  update_date   date not null,
  note          text,
  updated_by_email text,
  updated_by_name  text,
  is_sample     boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists acct_progress_project_idx on public.acct_progress_updates (project_id, update_date desc);

-- ------------------------------------------------------------
-- 7. Protected-action approval requests.
--    Requester must verify with a fresh emailed code; a Platform
--    Super Admin (platform_admins row, never the requester) decides.
-- ------------------------------------------------------------
create table if not exists public.acct_approval_requests (
  id                 uuid primary key default gen_random_uuid(),
  action             text not null check (action in (
                       'remove_sample_data','project_reset','project_delete','bulk_delete',
                       'void_posted_transaction','change_historical_rate','change_historical_fee_rule',
                       'post_refund','replace_from_backup','restore_version','restore_record')),
  project_id         text,
  payload            jsonb not null default '{}'::jsonb,
  impact             jsonb not null default '{}'::jsonb, -- affected records + financial impact shown to the approver
  reason             text not null,
  requester_email    text not null,
  requester_name     text,
  requester_role     text,
  requester_verified_at timestamptz not null,            -- when the emailed code was consumed
  status             text not null default 'pending'
                     check (status in ('pending','approved','rejected','executed','failed','cancelled')),
  approver_email     text,
  approver_note      text,
  decided_at         timestamptz,
  executed_at        timestamptz,
  result             jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists acct_approval_status_idx on public.acct_approval_requests (status, created_at desc);

-- ------------------------------------------------------------
-- 8. Append-only accounting audit history. Backend-controlled:
--    no client insert; UPDATE/DELETE blocked even for definers.
--    No application-level row limit.
-- ------------------------------------------------------------
create table if not exists public.acct_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_email  text,
  actor_name   text,
  actor_role   text,
  project_id   text,
  record_type  text,
  record_id    text,
  action       text not null,
  reason       text,
  approval_id  uuid,
  before_data  jsonb,
  after_data   jsonb,
  details      text
);

create index if not exists acct_audit_project_idx on public.acct_audit (project_id, at desc);
create index if not exists acct_audit_record_idx  on public.acct_audit (record_type, record_id);

create or replace function public.acct_audit_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'acct_audit is append-only: % is not permitted', tg_op;
end;
$$;

drop trigger if exists acct_audit_no_update on public.acct_audit;
create trigger acct_audit_no_update
  before update or delete on public.acct_audit
  for each row execute function public.acct_audit_block_mutation();

-- Truncate is also blocked.
drop trigger if exists acct_audit_no_truncate on public.acct_audit;
create trigger acct_audit_no_truncate
  before truncate on public.acct_audit
  for each statement execute function public.acct_audit_block_mutation();

-- ------------------------------------------------------------
-- 9. Review queue for ambiguous legacy / suspected duplicates.
-- ------------------------------------------------------------
create table if not exists public.acct_review_queue (
  id           uuid primary key default gen_random_uuid(),
  project_id   text,
  source       text not null default 'manual_flag'
               check (source in ('legacy_import','duplicate_suspect','missing_rate','fee_question','manual_flag')),
  record_type  text,
  record_ref   text,
  note         text,
  payload      jsonb,
  status       text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolved_by  text,
  resolution   text,
  created_by   text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create index if not exists acct_review_status_idx on public.acct_review_queue (status, created_at desc);

-- ------------------------------------------------------------
-- 10. Financial archives: complete snapshots taken before a project
--     reset / restore / backup replacement. No application-level cap.
-- ------------------------------------------------------------
create table if not exists public.acct_archives (
  id           uuid primary key default gen_random_uuid(),
  project_id   text,
  name         text not null,
  kind         text not null default 'project_reset'
               check (kind in ('project_reset','backup_replace','restore_point','sample_removal','void_snapshot')),
  snapshot     jsonb not null,
  approval_id  uuid,
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists acct_archives_project_idx on public.acct_archives (project_id, created_at desc);

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
create or replace function public.acct_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['acct_platform_settings','acct_projects','acct_transactions','acct_fee_ledger','acct_refund_settlements','acct_approval_requests']
  loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.acct_touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- Row Level Security.
--
-- Reads: any authenticated session (the app signs in — anonymously
-- today — before any data call; same model as app_state).
-- Writes: NO direct policies. Every write goes through the
-- SECURITY DEFINER RPCs in parts 2–4, which enforce the accounting
-- workflow rules (immutability of posted rows, approvals, append-only
-- audit, idempotent fees). Direct INSERT/UPDATE/DELETE from clients
-- is refused by RLS and by explicit REVOKEs.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['acct_platform_settings','acct_projects','acct_transactions','acct_fee_ledger',
                           'acct_refund_settlements','acct_progress_updates','acct_approval_requests',
                           'acct_audit','acct_review_queue','acct_archives']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "acct read" on public.%I', t);
    execute format('create policy "acct read" on public.%I for select using (auth.role() = ''authenticated'')', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end;
$$;
