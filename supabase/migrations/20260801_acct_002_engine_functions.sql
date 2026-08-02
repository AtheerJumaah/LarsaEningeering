-- ============================================================
-- Larsa Control — Accounting upgrade, part 2: transaction engine
--
-- All writes to the accounting tables happen through these
-- SECURITY DEFINER functions. They enforce, server-side:
--   * the exchange-rate hierarchy and immutable historical snapshots
--   * the consultancy-fee hierarchy, snapshotting, and idempotency
--   * incremental (per-source-transaction) fee generation
--   * posted-record immutability (corrections via void/reversal only)
--   * the append-only audit history
-- ============================================================

-- ------------------------------------------------------------
-- Small helpers
-- ------------------------------------------------------------
create or replace function public.acct_writer_roles()
returns text[]
language sql immutable
as $$ select array['Owner / Super Admin','Management','Accountant'] $$;

create or replace function public.acct_check_actor(actor jsonb, required text default 'write')
returns void
language plpgsql
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  a_role  text := coalesce(actor->>'role','');
begin
  if a_email = '' or position('@' in a_email) = 0 then
    raise exception 'ACCT_ACTOR: a valid actor email is required';
  end if;
  if required = 'write' and not (a_role = any (public.acct_writer_roles())) then
    raise exception 'ACCT_FORBIDDEN: role "%" cannot modify accounting records', a_role;
  end if;
  if required = 'progress' and not (a_role = any (public.acct_writer_roles() || array['Project Manager','Construction Engineer'])) then
    raise exception 'ACCT_FORBIDDEN: role "%" cannot record progress', a_role;
  end if;
end;
$$;

create or replace function public.acct_is_platform_admin(admin_email text)
returns boolean
language sql
security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.platform_admins where lower(email) = lower(coalesce(admin_email,'')));
$$;

-- Consume a fresh emailed verification code (sent through the existing
-- auth-code Edge Function). Same rules as the Edge Function: unexpired,
-- unconsumed, at most 5 attempts, newest code wins.
create or replace function public.acct_consume_email_code(p_email text, p_code text)
returns void
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  row_rec record;
begin
  if coalesce(trim(p_code),'') = '' then
    raise exception 'ACCT_CODE: enter the 6-digit code from your email';
  end if;
  -- Exact match among this mailbox's live codes (same rules as the
  -- auth-code Edge Function: unexpired, unconsumed, under 5 attempts).
  select id, code, attempts, expires_at into row_rec
    from public.auth_codes
   where email = lower(trim(p_email)) and purpose = 'verify' and consumed_at is null
     and expires_at >= now() and attempts < 5 and code = trim(p_code)
   order by created_at desc limit 1;
  if row_rec.id is not null then
    update public.auth_codes set consumed_at = now() where id = row_rec.id;
    return;
  end if;
  -- No match: burn an attempt on the newest live code, mirror the
  -- Edge Function's error sentences.
  select id, code, attempts, expires_at into row_rec
    from public.auth_codes
   where email = lower(trim(p_email)) and purpose = 'verify' and consumed_at is null
   order by created_at desc limit 1;
  if row_rec.id is null or row_rec.expires_at < now() then
    raise exception 'ACCT_CODE: that code has expired — ask for a new one';
  end if;
  if row_rec.attempts >= 5 then
    raise exception 'ACCT_CODE: too many wrong attempts — ask for a new code';
  end if;
  update public.auth_codes set attempts = attempts + 1 where id = row_rec.id;
  raise exception 'ACCT_CODE: that code was not accepted';
end;
$$;

create or replace function public.acct_log(
  actor jsonb, p_project text, p_record_type text, p_record_id text,
  p_action text, p_reason text default null, p_approval uuid default null,
  p_before jsonb default null, p_after jsonb default null, p_details text default null)
returns void
language sql
security definer set search_path = public, pg_temp
as $$
  insert into public.acct_audit
    (actor_email, actor_name, actor_role, project_id, record_type, record_id,
     action, reason, approval_id, before_data, after_data, details)
  values
    (lower(coalesce(actor->>'email','')), actor->>'name', actor->>'role',
     p_project, p_record_type, p_record_id, p_action, p_reason, p_approval,
     p_before, p_after, p_details);
$$;

-- ------------------------------------------------------------
-- Exchange-rate hierarchy:
--   transaction override > project default > platform default.
-- Returns {rate, source}.
-- ------------------------------------------------------------
create or replace function public.acct_resolve_rate(p_project_id text, p_override numeric default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  platform_rate numeric;
begin
  select default_exchange_rate into proj from public.acct_projects where id = p_project_id;
  select default_exchange_rate into platform_rate from public.acct_platform_settings where id = 1;
  if p_override is not null and p_override > 0 then
    return jsonb_build_object('rate', p_override, 'source', 'transaction_override');
  end if;
  if proj.default_exchange_rate is not null and proj.default_exchange_rate > 0 then
    return jsonb_build_object('rate', proj.default_exchange_rate, 'source', 'project_default');
  end if;
  return jsonb_build_object('rate', coalesce(platform_rate, 1310), 'source', 'platform_default');
end;
$$;

-- ------------------------------------------------------------
-- Consultancy-fee hierarchy:
--   transaction override > category/section override > project default
--   > platform default. Returns the fully-resolved rule as jsonb —
--   the caller copies it into the transaction as a permanent snapshot.
-- ------------------------------------------------------------
create or replace function public.acct_resolve_fee_rule(
  p_project_id text, p_kind text, p_category text default null, p_override jsonb default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  ps record;
  ov jsonb;
  rule jsonb;
begin
  select * into proj from public.acct_projects where id = p_project_id;
  select * into ps from public.acct_platform_settings where id = 1;

  -- 1. Transaction-level override
  if p_override is not null and coalesce(p_override->>'method','') <> '' then
    return jsonb_build_object(
      'method', p_override->>'method',
      'rate', coalesce((p_override->>'rate')::numeric, 0),
      'fixed', coalesce((p_override->>'fixed')::numeric, 0),
      'basis', coalesce(p_override->>'basis',
                        case when proj.fee_inherit or proj.fee_basis is null then ps.default_fee_basis else proj.fee_basis end),
      'basis_categories', coalesce(p_override->'basis_categories',
                        to_jsonb(case when proj.fee_inherit then ps.default_fee_basis_categories else proj.fee_basis_categories end)),
      'treatment', coalesce(p_override->>'treatment',
                        case when proj.fee_inherit or proj.fee_treatment is null then ps.default_fee_treatment else proj.fee_treatment end),
      'waived', coalesce((p_override->>'waived')::boolean, p_override->>'method' = 'waived'),
      'waiver_reason', p_override->>'waiver_reason',
      'source', 'transaction_override');
  end if;

  -- 2. Category/section override configured on the project
  if p_category is not null and proj.fee_category_overrides is not null then
    select o into ov
      from jsonb_array_elements(proj.fee_category_overrides) as o
     where lower(coalesce(o->>'category','')) = lower(p_category)
        or lower(coalesce(o->>'category','')) = lower(p_kind)
     limit 1;
    if ov is not null then
      return jsonb_build_object(
        'method', coalesce(ov->>'method','percentage'),
        'rate', coalesce((ov->>'rate')::numeric, 0),
        'fixed', coalesce((ov->>'fixed')::numeric, 0),
        'basis', coalesce(ov->>'basis',
                        case when proj.fee_inherit or proj.fee_basis is null then ps.default_fee_basis else proj.fee_basis end),
        'basis_categories', coalesce(ov->'basis_categories','[]'::jsonb),
        'treatment', coalesce(ov->>'treatment',
                        case when proj.fee_inherit or proj.fee_treatment is null then ps.default_fee_treatment else proj.fee_treatment end),
        'waived', coalesce(ov->>'method','') = 'waived',
        'source', 'category_override');
    end if;
  end if;

  -- 3. Project default (when the project defines its own rule)
  if proj.id is not null and not proj.fee_inherit and proj.fee_method is not null then
    return jsonb_build_object(
      'method', proj.fee_method,
      'rate', coalesce(proj.fee_rate, 0),
      'fixed', coalesce(proj.fee_fixed, 0),
      'basis', coalesce(proj.fee_basis, ps.default_fee_basis),
      'basis_categories', to_jsonb(coalesce(proj.fee_basis_categories, '{}'::text[])),
      'treatment', coalesce(proj.fee_treatment, ps.default_fee_treatment),
      'waived', proj.fee_method = 'waived',
      'source', 'project_default');
  end if;

  -- 4. Platform default (8% percentage on funding, deducted from funding)
  return jsonb_build_object(
    'method', ps.default_fee_method,
    'rate', ps.default_fee_rate,
    'fixed', ps.default_fee_fixed,
    'basis', ps.default_fee_basis,
    'basis_categories', to_jsonb(ps.default_fee_basis_categories),
    'treatment', ps.default_fee_treatment,
    'waived', ps.default_fee_method = 'waived',
    'source', 'platform_default');
end;
$$;

-- ------------------------------------------------------------
-- Is a transaction eligible, under `rule`, to generate a fee?
-- ------------------------------------------------------------
create or replace function public.acct_fee_eligible(p_kind text, p_category text, rule jsonb)
returns boolean
language plpgsql immutable
as $$
declare
  basis text := coalesce(rule->>'basis','funding');
  cats jsonb := coalesce(rule->'basis_categories','[]'::jsonb);
begin
  if coalesce((rule->>'waived')::boolean, false) and coalesce(rule->>'method','') <> 'waived' then
    -- explicit waiver on an otherwise eligible transaction: handled by caller
    null;
  end if;
  return case basis
    when 'funding'          then p_kind = 'funding'
    when 'income'           then p_kind = 'revenue'
    when 'total_expenses'   then p_kind in ('material','labor','expense')
    when 'materials_only'   then p_kind = 'material'
    when 'labor_only'       then p_kind = 'labor'
    when 'expense_categories' then p_kind in ('material','labor','expense')
      and exists (select 1 from jsonb_array_elements_text(cats) c
                  where lower(c) = lower(coalesce(p_category,'')) or lower(c) = lower(p_kind))
    when 'custom'           then exists (select 1 from jsonb_array_elements_text(cats) c
                  where lower(c) = lower(coalesce(p_category,'')) or lower(c) = lower(p_kind))
    else false
  end;
end;
$$;

-- Whether the fee for this source transaction should be POSTED
-- (vs merely estimated) given the source transaction's status.
create or replace function public.acct_fee_postable(p_kind text, p_status text)
returns boolean
language sql immutable
as $$
  select case
    when p_kind = 'funding' then p_status in ('received','posted')
    when p_kind = 'revenue' then p_status in ('received','posted','paid')
    else p_status in ('approved','posted','paid')   -- expense-based fees
  end;
$$;

-- ------------------------------------------------------------
-- Incremental, idempotent fee generation for ONE source transaction.
-- Additional funding generates only its additional fee; the current
-- percentage is never re-applied to the historical total. Backed by
-- the unique partial index acct_fee_source_uq.
-- ------------------------------------------------------------
create or replace function public.acct_sync_fee_for_txn(actor jsonb, p_txn_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  t record;
  rule jsonb;
  existing record;
  eligible boolean;
  postable boolean;
  target_status text;
  base numeric(18,2);
  fee numeric(18,2);
  f_iqd numeric(18,2);
  f_usd numeric(18,2);
  method text;
  fee_row public.acct_fee_ledger;
begin
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then
    raise exception 'ACCT_FEE: transaction % not found', p_txn_id;
  end if;
  if t.kind in ('refund','adjustment','reversal') then
    return jsonb_build_object('skipped','non-fee kind');
  end if;

  rule := coalesce(t.fee_rule, public.acct_resolve_fee_rule(t.project_id, t.kind, t.category, null));
  method := coalesce(rule->>'method','percentage');
  eligible := public.acct_fee_eligible(t.kind, t.category, rule) and method <> 'waived'
              and not coalesce((rule->>'waived')::boolean, false);

  select * into existing from public.acct_fee_ledger
   where source_txn_id = t.id and entry_type = 'fee' and status in ('estimated','posted','settled')
   limit 1;

  -- Source became rejected/void/reversed/deleted → an estimated fee dies;
  -- a posted fee must be reversed through the void/reversal workflow, not here.
  if t.status in ('rejected','void','reversed') or t.deleted_at is not null or not eligible then
    if existing.id is not null and existing.status = 'estimated' then
      update public.acct_fee_ledger set status = 'void', note = coalesce(note,'') || ' [estimate withdrawn]'
       where id = existing.id;
    end if;
    return jsonb_build_object('fee', null);
  end if;

  postable := public.acct_fee_postable(t.kind, t.status);
  target_status := case when postable then 'posted' else 'estimated' end;

  base := t.original_amount;
  fee := case method
    when 'percentage' then round(base * coalesce((rule->>'rate')::numeric, 0), 2)
    when 'fixed_per_transaction' then round(coalesce((rule->>'fixed')::numeric, 0), 2)
    when 'fixed_per_project' then round(coalesce((rule->>'fixed')::numeric, 0), 2)
    else 0 end;

  -- Fee uses the SOURCE transaction's currency and exchange-rate snapshot.
  if t.original_currency = 'IQD' then
    f_iqd := fee; f_usd := round(fee / t.exchange_rate, 2);
  else
    f_usd := fee; f_iqd := round(fee * t.exchange_rate, 2);
  end if;

  if existing.id is not null then
    -- Never overwrite a posted historical fee.
    if existing.status in ('posted','settled') then
      return jsonb_build_object('fee', to_jsonb(existing), 'unchanged', true);
    end if;
    update public.acct_fee_ledger
       set status = target_status,
           provisional = (t.kind = 'funding' and postable),
           fee_rate = (rule->>'rate')::numeric,
           fixed_amount = (rule->>'fixed')::numeric,
           calc_method = method,
           calc_basis = coalesce(rule->>'basis','funding'),
           basis_amount = base,
           fee_amount = fee,
           currency = t.original_currency,
           exchange_rate = t.exchange_rate,
           fee_iqd = f_iqd,
           fee_usd = f_usd,
           treatment = coalesce(rule->>'treatment','deduct_from_funding'),
           config_source = coalesce(rule->>'source','project_default'),
           approved_by = case when postable then coalesce(actor->>'email', approved_by) else approved_by end
     where id = existing.id
     returning * into fee_row;
  else
    begin
      insert into public.acct_fee_ledger
        (project_id, source_txn_id, entry_type, calc_method, fee_rate, fixed_amount, calc_basis,
         basis_amount, fee_amount, currency, exchange_rate, fee_iqd, fee_usd, treatment,
         config_source, status, provisional, is_sample, created_by,
         approved_by)
      values
        (t.project_id, t.id, 'fee', method, (rule->>'rate')::numeric, (rule->>'fixed')::numeric,
         coalesce(rule->>'basis','funding'), base, fee, t.original_currency, t.exchange_rate,
         f_iqd, f_usd, coalesce(rule->>'treatment','deduct_from_funding'),
         coalesce(rule->>'source','project_default'), target_status,
         (t.kind = 'funding' and postable), t.is_sample, actor->>'email',
         case when postable then actor->>'email' end)
      returning * into fee_row;
    exception when unique_violation then
      -- A concurrent call already generated this transaction's fee (or the
      -- fixed-per-project fee already exists): the same amount can never
      -- produce the same fee twice.
      select * into fee_row from public.acct_fee_ledger
       where source_txn_id = t.id and entry_type = 'fee' and status in ('estimated','posted','settled') limit 1;
      return jsonb_build_object('fee', to_jsonb(fee_row), 'duplicate_prevented', true);
    end;
  end if;

  if postable and (existing.id is null or existing.status = 'estimated') then
    perform public.acct_log(actor, t.project_id, 'fee', fee_row.id::text, 'Consultancy Fee Posted', null, null, null,
      to_jsonb(fee_row), format('%s %s fee on %s %s (%s, rate snapshot %s)',
        fee, t.original_currency, t.kind, t.txn_no, coalesce(rule->>'basis','funding'), coalesce(rule->>'rate','-')));
  end if;

  return jsonb_build_object('fee', to_jsonb(fee_row));
end;
$$;

-- ------------------------------------------------------------
-- Post a new accounting transaction (the ONE authoritative entry
-- point for funding / materials / labor / expenses / revenue /
-- adjustments). Resolves the exchange-rate and fee hierarchies,
-- snapshots both permanently, generates the incremental fee, guards
-- against duplicates, audits everything.
-- ------------------------------------------------------------
create or replace function public.acct_post_transaction(actor jsonb, txn jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
#variable_conflict use_variable
declare
  proj record;
  kind text := lower(coalesce(txn->>'kind',''));
  cur  text := upper(coalesce(txn->>'currency', txn->>'original_currency', ''));
  amt  numeric(18,2) := coalesce((txn->>'amount')::numeric, (txn->>'original_amount')::numeric);
  st   text := lower(coalesce(txn->>'status','draft'));
  rate_res jsonb;
  rate numeric(14,6);
  rate_src text;
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  rule jsonb;
  new_no text;
  new_receipt text;
  row_txn public.acct_transactions;
  fee_result jsonb;
  dup_count int;
  p_client_key uuid;
begin
  perform public.acct_check_actor(actor, 'write');

  select * into proj from public.acct_projects where id = txn->>'project_id';
  if proj.id is null then
    raise exception 'ACCT_TXN: unknown project "%"', txn->>'project_id';
  end if;
  if proj.archived_at is not null then
    raise exception 'ACCT_TXN: project "%" is archived', proj.name;
  end if;
  if kind not in ('funding','material','labor','expense','revenue','adjustment') then
    raise exception 'ACCT_TXN: unsupported kind "%" (refunds go through the refund settlement workflow)', kind;
  end if;
  if cur not in ('USD','IQD') then cur := proj.currency; end if;
  if amt is null or (amt <= 0 and kind <> 'adjustment') then
    raise exception 'ACCT_TXN: amount must be a positive number';
  end if;
  if st not in ('draft','pending','approved','posted','received','paid') then
    raise exception 'ACCT_TXN: invalid initial status "%"', st;
  end if;

  -- Idempotency: same client_key returns the already-posted transaction.
  p_client_key := nullif(txn->>'client_key','')::uuid;
  if p_client_key is not null then
    select * into row_txn from public.acct_transactions where client_key = p_client_key;
    if row_txn.id is not null then
      return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn), 'idempotent_replay', true);
    end if;
  end if;

  -- Exchange-rate hierarchy + permanent snapshot
  rate_res := public.acct_resolve_rate(proj.id, nullif(txn->>'exchange_rate','')::numeric);
  rate := (rate_res->>'rate')::numeric;
  rate_src := rate_res->>'source';
  if cur = 'IQD' then
    a_iqd := round(amt, 2); a_usd := round(amt / rate, 2);
  else
    a_usd := round(amt, 2); a_iqd := round(amt * rate, 2);
  end if;

  -- Consultancy-fee hierarchy + permanent snapshot
  rule := public.acct_resolve_fee_rule(proj.id, kind, txn->>'category', txn->'fee_override');
  if coalesce((rule->>'waived')::boolean,false) and coalesce(rule->>'waiver_reason','') = ''
     and coalesce(rule->>'source','') = 'transaction_override' then
    raise exception 'ACCT_FEE: waiving the consultancy fee requires a reason';
  end if;

  new_no := 'LRS-TXN-' || lpad(nextval('public.acct_txn_no_seq')::text, 6, '0');
  if st in ('approved','posted','received','paid') then
    new_receipt := 'LRS-RCP-' || lpad(nextval('public.acct_receipt_no_seq')::text, 6, '0');
  end if;

  insert into public.acct_transactions
    (txn_no, receipt_no, project_id, kind, category, description, supplier, quantity, unit,
     txn_date, status, payment_source,
     original_amount, original_currency, exchange_rate, rate_direction, rate_date, rate_source,
     rate_note, rate_confirmed_by, amount_iqd, amount_usd, fee_rule,
     is_sample, client_key, external_ref, attachment_path, meta,
     created_by_email, created_by_name, created_by_role,
     approved_by, approved_at, posted_at)
  values
    (new_no, new_receipt, proj.id, kind, txn->>'category', txn->>'description', txn->>'supplier',
     nullif(txn->>'quantity','')::numeric, txn->>'unit',
     coalesce(nullif(txn->>'date','')::date, current_date), st, txn->>'payment_source',
     round(amt,2), cur, rate, 'USD_TO_IQD',
     coalesce(nullif(txn->>'rate_date','')::date, coalesce(nullif(txn->>'date','')::date, current_date)),
     rate_src, txn->>'rate_note', coalesce(actor->>'email',''), a_iqd, a_usd, rule,
     coalesce((txn->>'is_sample')::boolean, false), p_client_key,
     nullif(txn->>'external_ref',''), nullif(txn->>'attachment_path',''),
     coalesce(txn->'meta','{}'::jsonb),
     lower(coalesce(actor->>'email','')), actor->>'name', actor->>'role',
     case when st in ('approved','posted','received','paid') then lower(coalesce(actor->>'email','')) end,
     case when st in ('approved','posted','received','paid') then now() end,
     case when st in ('posted','received','paid') then now() end)
  returning * into row_txn;

  -- Duplicate heuristic (non-blocking): same project + kind + amount + date
  -- already live → flag for review instead of silently double-counting.
  select count(*) into dup_count from public.acct_transactions x
   where x.project_id = proj.id and x.kind = kind and x.id <> row_txn.id
     and x.original_amount = row_txn.original_amount and x.original_currency = row_txn.original_currency
     and x.txn_date = row_txn.txn_date
     and x.status not in ('void','rejected','reversed') and x.deleted_at is null;
  if dup_count > 0 then
    insert into public.acct_review_queue (project_id, source, record_type, record_ref, note, payload, created_by)
    values (proj.id, 'duplicate_suspect', kind, row_txn.txn_no,
            format('Possible duplicate: %s existing %s transaction(s) with the same amount and date', dup_count, kind),
            jsonb_build_object('txn_id', row_txn.id), actor->>'email');
  end if;

  fee_result := public.acct_sync_fee_for_txn(actor, row_txn.id);

  perform public.acct_log(actor, proj.id, kind, row_txn.id::text,
    initcap(kind) || ' Added', txn->>'reason', null, null, to_jsonb(row_txn),
    format('%s %s %s (%s) — rate %s (%s)', row_txn.txn_no, amt, cur, st, rate, rate_src));

  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn), 'fee', fee_result->'fee');
end;
$$;

-- ------------------------------------------------------------
-- Edit an UNPOSTED transaction (draft/pending only). Posted records
-- are immutable — corrections go through void + replacement.
-- ------------------------------------------------------------
create or replace function public.acct_update_transaction(actor jsonb, p_txn_id uuid, changes jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  t record;
  before jsonb;
  cur text;
  amt numeric(18,2);
  rate numeric(14,6);
  rate_src text;
  rate_res jsonb;
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  rule jsonb;
  row_txn public.acct_transactions;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: not found'; end if;
  if t.status not in ('draft','pending') or t.deleted_at is not null then
    raise exception 'ACCT_IMMUTABLE: % is %; posted accounting records are corrected by reversal/replacement, not edited', t.txn_no, t.status;
  end if;

  before := to_jsonb(t);
  cur := upper(coalesce(changes->>'currency', t.original_currency));
  amt := coalesce((changes->>'amount')::numeric, t.original_amount);

  if changes ? 'exchange_rate' and nullif(changes->>'exchange_rate','') is not null then
    rate := (changes->>'exchange_rate')::numeric; rate_src := 'transaction_override';
  elsif changes ? 'currency' or changes ? 'amount' then
    rate := t.exchange_rate; rate_src := t.rate_source;   -- keep the snapshot
  else
    rate := t.exchange_rate; rate_src := t.rate_source;
  end if;
  if cur = 'IQD' then a_iqd := round(amt,2); a_usd := round(amt / rate, 2);
  else a_usd := round(amt,2); a_iqd := round(amt * rate, 2); end if;

  rule := case when changes ? 'fee_override'
    then public.acct_resolve_fee_rule(t.project_id, t.kind, coalesce(changes->>'category', t.category), changes->'fee_override')
    else t.fee_rule end;

  update public.acct_transactions set
    category = coalesce(changes->>'category', category),
    description = coalesce(changes->>'description', description),
    supplier = coalesce(changes->>'supplier', supplier),
    quantity = coalesce(nullif(changes->>'quantity','')::numeric, quantity),
    unit = coalesce(changes->>'unit', unit),
    txn_date = coalesce(nullif(changes->>'date','')::date, txn_date),
    payment_source = coalesce(changes->>'payment_source', payment_source),
    original_amount = round(amt,2),
    original_currency = cur,
    exchange_rate = rate,
    rate_source = rate_src,
    rate_note = coalesce(changes->>'rate_note', rate_note),
    rate_confirmed_by = coalesce(actor->>'email', rate_confirmed_by),
    amount_iqd = a_iqd,
    amount_usd = a_usd,
    fee_rule = rule,
    external_ref = coalesce(nullif(changes->>'external_ref',''), external_ref),
    attachment_path = coalesce(nullif(changes->>'attachment_path',''), attachment_path),
    meta = meta || coalesce(changes->'meta','{}'::jsonb)
  where id = t.id
  returning * into row_txn;

  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind) || ' Edited',
    changes->>'reason', null, before, to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

-- ------------------------------------------------------------
-- Status transitions. Posting statuses trigger the incremental fee.
-- Once posted, a transaction never transitions except through the
-- protected void workflow.
-- ------------------------------------------------------------
create or replace function public.acct_set_txn_status(actor jsonb, p_txn_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  t record;
  before jsonb;
  new_receipt text;
  row_txn public.acct_transactions;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: not found'; end if;
  if t.deleted_at is not null then raise exception 'ACCT_TXN: record is deleted; restore it first'; end if;
  if p_status not in ('draft','pending','approved','posted','received','paid','rejected') then
    raise exception 'ACCT_TXN: invalid status "%"', p_status;
  end if;
  if t.status in ('posted','received','paid','void','reversed') then
    raise exception 'ACCT_IMMUTABLE: % is %; use the protected void/reversal workflow', t.txn_no, t.status;
  end if;
  before := to_jsonb(t);

  new_receipt := t.receipt_no;
  if p_status in ('approved','posted','received','paid') and t.receipt_no is null then
    new_receipt := 'LRS-RCP-' || lpad(nextval('public.acct_receipt_no_seq')::text, 6, '0');
  end if;

  update public.acct_transactions set
    status = p_status,
    receipt_no = new_receipt,
    approved_by = case when p_status in ('approved','posted','received','paid') then lower(coalesce(actor->>'email','')) else approved_by end,
    approved_at = case when p_status in ('approved','posted','received','paid') then now() else approved_at end,
    posted_at = case when p_status in ('posted','received','paid') then now() else posted_at end
  where id = t.id
  returning * into row_txn;

  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text,
    case when p_status = 'rejected' then initcap(t.kind) || ' Rejected' else initcap(t.kind) || ' ' || initcap(p_status) end,
    p_note, null, before, to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

-- ------------------------------------------------------------
-- Soft-delete (drafts/pending only) and restore. Nothing is ever
-- physically erased.
-- ------------------------------------------------------------
create or replace function public.acct_soft_delete(actor jsonb, p_txn_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare t record; row_txn public.acct_transactions;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: not found'; end if;
  if t.status not in ('draft','pending','rejected') then
    raise exception 'ACCT_IMMUTABLE: % is %; posted records are voided or reversed through the protected workflow, never deleted', t.txn_no, t.status;
  end if;
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'ACCT_TXN: a reason is required to delete a record';
  end if;
  update public.acct_transactions
     set deleted_at = now(), deleted_by = lower(coalesce(actor->>'email','')), delete_reason = p_reason
   where id = t.id returning * into row_txn;
  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind) || ' Deleted (soft)',
    p_reason, null, to_jsonb(t), to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

create or replace function public.acct_restore_record(actor jsonb, p_txn_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare t record; row_txn public.acct_transactions;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: not found'; end if;
  if t.deleted_at is null then return jsonb_build_object('ok', true, 'txn', to_jsonb(t)); end if;
  update public.acct_transactions
     set deleted_at = null, deleted_by = null, delete_reason = null
   where id = t.id returning * into row_txn;
  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind) || ' Restored',
    p_reason, null, to_jsonb(t), to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

-- ------------------------------------------------------------
-- Schedule / physical progress (append-only history).
-- ------------------------------------------------------------
create or replace function public.acct_record_progress(actor jsonb, p_project_id text, p_percent numeric, p_date date, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare proj record; row_p public.acct_progress_updates;
begin
  perform public.acct_check_actor(actor, 'progress');
  select * into proj from public.acct_projects where id = p_project_id;
  if proj.id is null then raise exception 'ACCT_PROGRESS: unknown project'; end if;
  if p_percent is null or p_percent < 0 or p_percent > 100 then
    raise exception 'ACCT_PROGRESS: percent must be between 0 and 100';
  end if;
  insert into public.acct_progress_updates (project_id, percent, update_date, note, updated_by_email, updated_by_name, is_sample)
  values (proj.id, round(p_percent,2), coalesce(p_date, current_date), p_note,
          lower(coalesce(actor->>'email','')), actor->>'name', proj.is_sample)
  returning * into row_p;
  perform public.acct_log(actor, proj.id, 'progress', row_p.id::text, 'Progress Updated', p_note, null, null,
    to_jsonb(row_p), format('%s%% on %s', round(p_percent,2), coalesce(p_date, current_date)));
  return jsonb_build_object('ok', true, 'progress', to_jsonb(row_p));
end;
$$;

-- ------------------------------------------------------------
-- Project upsert (accounting configuration). Changing a project's
-- default exchange rate or fee rule NEVER touches historical
-- transactions — their snapshots are frozen at posting time.
-- ------------------------------------------------------------
create or replace function public.acct_upsert_project(actor jsonb, p jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  pid text := coalesce(nullif(p->>'id',''), 'prj' || replace(gen_random_uuid()::text, '-', ''));
  before jsonb;
  row_p public.acct_projects;
begin
  perform public.acct_check_actor(actor, 'write');
  select to_jsonb(x) into before from public.acct_projects x where x.id = pid;

  insert into public.acct_projects as ap
    (id, code, name, client, region, type, status, currency, contract_value, approved_budget, budget_currency,
     default_exchange_rate, fee_inherit, fee_method, fee_rate, fee_fixed, fee_basis, fee_basis_categories,
     fee_treatment, fee_category_overrides, is_sample, legacy_id, created_by)
  values
    (pid, p->>'code', coalesce(p->>'name','(unnamed project)'), p->>'client',
     coalesce(p->>'region','Iraq'), coalesce(p->>'type','Construction'), coalesce(p->>'status','Active'),
     case when upper(coalesce(p->>'currency','')) in ('USD','IQD') then upper(p->>'currency') else 'IQD' end,
     nullif(p->>'contract_value','')::numeric, nullif(p->>'approved_budget','')::numeric,
     case when upper(coalesce(p->>'budget_currency','')) in ('USD','IQD') then upper(p->>'budget_currency') end,
     nullif(p->>'default_exchange_rate','')::numeric,
     coalesce((p->>'fee_inherit')::boolean, true),
     nullif(p->>'fee_method',''), nullif(p->>'fee_rate','')::numeric, nullif(p->>'fee_fixed','')::numeric,
     nullif(p->>'fee_basis',''),
     coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'fee_basis_categories','[]'::jsonb)) x), '{}'),
     nullif(p->>'fee_treatment',''), coalesce(p->'fee_category_overrides','[]'::jsonb),
     coalesce((p->>'is_sample')::boolean, false), nullif(p->>'legacy_id',''), actor->>'email')
  on conflict (id) do update set
    code = coalesce(excluded.code, ap.code),
    name = coalesce(excluded.name, ap.name),
    client = coalesce(excluded.client, ap.client),
    region = coalesce(excluded.region, ap.region),
    type = coalesce(excluded.type, ap.type),
    status = coalesce(excluded.status, ap.status),
    currency = coalesce(excluded.currency, ap.currency),
    contract_value = coalesce(excluded.contract_value, ap.contract_value),
    approved_budget = coalesce(excluded.approved_budget, ap.approved_budget),
    budget_currency = coalesce(excluded.budget_currency, ap.budget_currency),
    default_exchange_rate = case when p ? 'default_exchange_rate' then nullif(p->>'default_exchange_rate','')::numeric else ap.default_exchange_rate end,
    fee_inherit = coalesce((p->>'fee_inherit')::boolean, ap.fee_inherit),
    fee_method = case when p ? 'fee_method' then nullif(p->>'fee_method','') else ap.fee_method end,
    fee_rate = case when p ? 'fee_rate' then nullif(p->>'fee_rate','')::numeric else ap.fee_rate end,
    fee_fixed = case when p ? 'fee_fixed' then nullif(p->>'fee_fixed','')::numeric else ap.fee_fixed end,
    fee_basis = case when p ? 'fee_basis' then nullif(p->>'fee_basis','') else ap.fee_basis end,
    fee_basis_categories = case when p ? 'fee_basis_categories'
      then coalesce((select array_agg(x) from jsonb_array_elements_text(p->'fee_basis_categories') x), '{}')
      else ap.fee_basis_categories end,
    fee_treatment = case when p ? 'fee_treatment' then nullif(p->>'fee_treatment','') else ap.fee_treatment end,
    fee_category_overrides = case when p ? 'fee_category_overrides' then p->'fee_category_overrides' else ap.fee_category_overrides end
  returning * into row_p;

  perform public.acct_log(actor, row_p.id, 'project', row_p.id,
    case when before is null then 'Project Added' else 'Project Accounting Settings Edited' end,
    p->>'reason', null, before, to_jsonb(row_p), row_p.name);
  return jsonb_build_object('ok', true, 'project', to_jsonb(row_p));
end;
$$;

-- ------------------------------------------------------------
-- Platform settings: only a Platform Super Admin with a fresh
-- emailed code may change platform accounting defaults.
-- ------------------------------------------------------------
create or replace function public.acct_save_platform_settings(actor jsonb, p_code text, changes jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  before jsonb;
  row_s public.acct_platform_settings;
begin
  if not public.acct_is_platform_admin(a_email) then
    raise exception 'ACCT_FORBIDDEN: only a Platform Super Admin may change platform accounting defaults';
  end if;
  perform public.acct_consume_email_code(a_email, p_code);
  select to_jsonb(x) into before from public.acct_platform_settings x where x.id = 1;

  update public.acct_platform_settings set
    default_exchange_rate = coalesce(nullif(changes->>'default_exchange_rate','')::numeric, default_exchange_rate),
    default_fee_method = coalesce(nullif(changes->>'default_fee_method',''), default_fee_method),
    default_fee_rate = coalesce(nullif(changes->>'default_fee_rate','')::numeric, default_fee_rate),
    default_fee_fixed = coalesce(nullif(changes->>'default_fee_fixed','')::numeric, default_fee_fixed),
    default_fee_basis = coalesce(nullif(changes->>'default_fee_basis',''), default_fee_basis),
    default_fee_basis_categories = case when changes ? 'default_fee_basis_categories'
      then coalesce((select array_agg(x) from jsonb_array_elements_text(changes->'default_fee_basis_categories') x), '{}')
      else default_fee_basis_categories end,
    default_fee_treatment = coalesce(nullif(changes->>'default_fee_treatment',''), default_fee_treatment),
    display_timezone = coalesce(nullif(changes->>'display_timezone',''), display_timezone),
    updated_by = a_email
  where id = 1
  returning * into row_s;

  perform public.acct_log(actor, null, 'platform_settings', '1', 'Platform Accounting Defaults Changed',
    changes->>'reason', null, before, to_jsonb(row_s),
    'Defaults apply to FUTURE transactions only; historical snapshots are never recalculated');
  return jsonb_build_object('ok', true, 'settings', to_jsonb(row_s));
end;
$$;

-- ------------------------------------------------------------
-- Manual review-queue actions
-- ------------------------------------------------------------
create or replace function public.acct_resolve_review(actor jsonb, p_id uuid, p_resolution text, p_dismiss boolean default false)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare r record;
begin
  perform public.acct_check_actor(actor, 'write');
  select * into r from public.acct_review_queue where id = p_id;
  if r.id is null then raise exception 'ACCT_REVIEW: not found'; end if;
  update public.acct_review_queue
     set status = case when p_dismiss then 'dismissed' else 'resolved' end,
         resolved_by = lower(coalesce(actor->>'email','')), resolution = p_resolution, resolved_at = now()
   where id = p_id;
  perform public.acct_log(actor, r.project_id, 'review', p_id::text,
    case when p_dismiss then 'Review Item Dismissed' else 'Review Item Resolved' end, p_resolution, null, to_jsonb(r), null, null);
  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------
-- Grants: RPCs are callable by any signed-in session; the functions
-- themselves enforce roles, codes, and approvals.
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'acct_is_platform_admin(text)',
    'acct_resolve_rate(text,numeric)',
    'acct_resolve_fee_rule(text,text,text,jsonb)',
    'acct_post_transaction(jsonb,jsonb)',
    'acct_update_transaction(jsonb,uuid,jsonb)',
    'acct_set_txn_status(jsonb,uuid,text,text)',
    'acct_soft_delete(jsonb,uuid,text)',
    'acct_restore_record(jsonb,uuid,text)',
    'acct_record_progress(jsonb,text,numeric,date,text)',
    'acct_upsert_project(jsonb,jsonb)',
    'acct_save_platform_settings(jsonb,text,jsonb)',
    'acct_resolve_review(jsonb,uuid,text,boolean)',
    'acct_sync_fee_for_txn(jsonb,uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Internal helpers stay callable only from definer functions.
  revoke all on function public.acct_consume_email_code(text,text) from public, anon, authenticated;
  revoke all on function public.acct_log(jsonb,text,text,text,text,text,uuid,jsonb,jsonb,text) from public, anon, authenticated;
end;
$$;
