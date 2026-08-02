-- ============================================================
-- Larsa Control — Accounting upgrade, part 6:
--   * review/approval workflow (working totals never blocked)
--   * client funding receipts (immutable snapshots, print history)
--   * project funding statements
--   * granular multi-accountant permissions
--
-- Additive and backward-compatible. The approval axis is SEPARATE
-- from the payment/posting axis: approval changes the reliability
-- status of a number, never the calculated amount.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Review status on every accounting transaction
-- ------------------------------------------------------------
alter table public.acct_transactions
  add column if not exists review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed','pending_review','approved','needs_correction')),
  add column if not exists review_submitted_at timestamptz,
  add column if not exists review_submitted_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists review_comment text,
  add column if not exists self_approved boolean not null default false;

-- Backfill: entries that were already settled on the payment axis were
-- entered as trusted records before the review workflow existed — mark them
-- review-approved by migration so historical totals stay green; anything
-- still draft/pending starts unreviewed.
update public.acct_transactions
   set review_status = 'approved', reviewed_at = now(), reviewed_by = 'migration'
 where review_status = 'unreviewed' and status in ('approved','posted','received','paid');

create index if not exists acct_txn_review_idx on public.acct_transactions (project_id, review_status);

-- ------------------------------------------------------------
-- 2. Granular accounting permissions (per user email), with
--    role-based defaults. Configured only by the Platform Super
--    Admin through acct_set_permissions (email code required).
-- ------------------------------------------------------------
create table if not exists public.acct_permissions (
  email       text primary key,
  grants      jsonb not null default '{}'::jsonb,  -- {"create":true,"approve":false,...} explicit overrides
  note        text,
  granted_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.acct_permissions enable row level security;
drop policy if exists "acct read" on public.acct_permissions;
create policy "acct read" on public.acct_permissions for select using (auth.role() = 'authenticated');
revoke insert, update, delete on public.acct_permissions from anon, authenticated;
grant select on public.acct_permissions to anon, authenticated;

-- Role defaults. An explicit per-user grant (true or false) always wins.
create or replace function public.acct_role_default_perms(p_role text)
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_role in ('Owner / Super Admin','Management') then
      array['view','create','edit_own_unapproved','edit_any_unapproved','submit_review','review','approve','reject',
            'print_receipts','reprint_receipts','post_refunds','approve_refunds','reopen_approved',
            'export_working','export_approved']
    when p_role = 'Accountant' then
      array['view','create','edit_own_unapproved','submit_review','print_receipts','reprint_receipts','post_refunds','export_working']
    when p_role = 'Payroll Accountant' then
      array['view','export_working']
    when p_role in ('Project Manager','Construction Engineer') then
      array['view']
    else array['view']
  end;
$$;

create or replace function public.acct_has_perm(actor jsonb, p_perm text)
returns boolean
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  g jsonb;
begin
  select grants into g from public.acct_permissions where email = a_email;
  if g is not null and g ? p_perm then
    return coalesce((g->>p_perm)::boolean, false);
  end if;
  return p_perm = any (public.acct_role_default_perms(coalesce(actor->>'role','')));
end;
$$;

create or replace function public.acct_check_perm(actor jsonb, p_perm text)
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare a_email text := lower(coalesce(actor->>'email',''));
begin
  if a_email = '' or position('@' in a_email) = 0 then
    raise exception 'ACCT_ACTOR: a valid actor email is required';
  end if;
  if not public.acct_has_perm(actor, p_perm) then
    raise exception 'ACCT_FORBIDDEN: your accounting permissions do not include "%"', p_perm;
  end if;
end;
$$;

-- Every pre-existing write entry point checked roles through
-- acct_check_actor. Route it through the granular permission engine so
-- per-user grants (e.g. a view-only accountant) apply everywhere at once.
create or replace function public.acct_check_actor(actor jsonb, required text default 'write')
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  a_role  text := coalesce(actor->>'role','');
begin
  if a_email = '' or position('@' in a_email) = 0 then
    raise exception 'ACCT_ACTOR: a valid actor email is required';
  end if;
  if required = 'write' then
    perform public.acct_check_perm(actor, 'create');
  elsif required = 'progress' then
    if not (a_role = any (array['Owner / Super Admin','Management','Accountant','Project Manager','Construction Engineer'])
            or public.acct_has_perm(actor, 'create')) then
      raise exception 'ACCT_FORBIDDEN: role "%" cannot record progress', a_role;
    end if;
  end if;
end;
$$;

-- Platform Super Admin configures per-user permissions (fresh email code).
create or replace function public.acct_set_permissions(actor jsonb, p_code text, p_email text, p_grants jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  before jsonb;
begin
  if not public.acct_is_platform_admin(a_email) then
    raise exception 'ACCT_FORBIDDEN: only a Platform Super Admin may configure accounting permissions';
  end if;
  perform public.acct_consume_email_code(a_email, p_code);
  select to_jsonb(x) into before from public.acct_permissions x where x.email = lower(p_email);
  insert into public.acct_permissions as ap (email, grants, note, granted_by)
  values (lower(p_email), coalesce(p_grants,'{}'::jsonb), p_note, a_email)
  on conflict (email) do update
    set grants = coalesce(excluded.grants,'{}'::jsonb), note = coalesce(excluded.note, ap.note), granted_by = excluded.granted_by;
  perform public.acct_log(actor, null, 'permissions', lower(p_email), 'Accounting Permissions Changed',
    p_note, null, before, p_grants, 'Explicit per-user grants override the role defaults');
  return jsonb_build_object('ok', true);
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
    'print_receipts','reprint_receipts','post_refunds','approve_refunds','reopen_approved','export_working','export_approved','self_approve','manage_permissions'];
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
-- 3. Client funding receipts: immutable snapshots + print history
-- ------------------------------------------------------------
create table if not exists public.acct_receipts (
  id            uuid primary key default gen_random_uuid(),
  receipt_no    text not null unique,               -- server-generated LRS-RCP-… (never reused)
  txn_id        uuid not null references public.acct_transactions(id),
  project_id    text not null references public.acct_projects(id),
  version       integer not null default 1,
  kind          text not null default 'original' check (kind in ('original','corrected')),
  corrects_receipt_id uuid references public.acct_receipts(id),
  corrected_by_receipt_id uuid references public.acct_receipts(id),
  snapshot      jsonb not null,                     -- immutable issue-time snapshot (see acct_issue_receipt)
  status_at_issue text not null default 'unreviewed',
  voided_at     timestamptz,
  void_reason   text,
  is_sample     boolean not null default false,
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists acct_receipts_txn_idx on public.acct_receipts (txn_id);
create index if not exists acct_receipts_project_idx on public.acct_receipts (project_id, created_at desc);

-- The snapshot and number of an issued receipt can never be rewritten.
create or replace function public.acct_receipt_block_rewrite()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- Real receipts are permanent. Only records marked as sample data may
    -- be deleted, and only by the protected sample-removal workflow.
    if old.is_sample then return old; end if;
    raise exception 'acct_receipts are permanent: DELETE is not permitted';
  end if;
  if new.snapshot is distinct from old.snapshot
     or new.receipt_no is distinct from old.receipt_no
     or new.txn_id is distinct from old.txn_id
     or new.created_at is distinct from old.created_at then
    raise exception 'acct_receipts are immutable: the snapshot and receipt number can never change';
  end if;
  return new;
end;
$$;
drop trigger if exists acct_receipts_immutable on public.acct_receipts;
create trigger acct_receipts_immutable
  before update or delete on public.acct_receipts
  for each row execute function public.acct_receipt_block_rewrite();

create table if not exists public.acct_receipt_prints (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references public.acct_receipts(id),
  printed_by_email text,
  printed_by_name  text,
  printed_at    timestamptz not null default now(),
  version       integer not null default 1,
  approval_status_at_print text,
  is_reprint    boolean not null default false,
  reason        text
);
create index if not exists acct_receipt_prints_idx on public.acct_receipt_prints (receipt_id, printed_at desc);

do $$
declare t text;
begin
  foreach t in array array['acct_receipts','acct_receipt_prints']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "acct read" on public.%I', t);
    execute format('create policy "acct read" on public.%I for select using (auth.role() = ''authenticated'')', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end;
$$;

-- Issue (or return the existing) receipt for a funding transaction.
-- The snapshot freezes every fact the printed receipt shows, so later
-- changes to client names, defaults, or settings never rewrite it.
create or replace function public.acct_issue_receipt(actor jsonb, p_txn_id uuid, p_kind text default 'original', p_corrects uuid default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  t record; proj record; fee record; ps record;
  existing record;
  new_no text;
  snap jsonb;
  row_r public.acct_receipts;
begin
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_RECEIPT: transaction not found'; end if;
  if t.kind <> 'funding' then raise exception 'ACCT_RECEIPT: receipts are issued for funding transactions'; end if;

  if p_kind = 'corrected' then
    perform public.acct_check_perm(actor, 'print_receipts');
  end if;

  -- A replacement funding entry (posted through the approved correction
  -- workflow) automatically gets a CORRECTED receipt that references the
  -- original transaction's receipt — never a look-alike original.
  if p_kind = 'original' and t.meta ? 'replacement_of' and p_corrects is null then
    select r.id into p_corrects from public.acct_receipts r
     where r.txn_id = (t.meta->>'replacement_of')::uuid and r.kind = 'original'
     order by r.created_at limit 1;
    if p_corrects is not null then p_kind := 'corrected'; end if;
  end if;

  if p_kind = 'original' then
    select * into existing from public.acct_receipts
     where txn_id = t.id and kind = 'original' and voided_at is null limit 1;
    if existing.id is not null then
      return jsonb_build_object('ok', true, 'receipt', to_jsonb(existing), 'already_issued', true);
    end if;
  end if;

  select * into proj from public.acct_projects where id = t.project_id;
  select * into ps from public.acct_platform_settings where id = 1;
  select * into fee from public.acct_fee_ledger
   where source_txn_id = t.id and entry_type = 'fee' and status in ('estimated','posted','settled') limit 1;

  -- Reuse the transaction's server receipt number when it already has one
  -- (posted entries), otherwise draw the next number in the same sequence.
  -- A corrected receipt always gets a NEW number and references the original.
  if p_kind = 'original' and t.receipt_no is not null then
    new_no := t.receipt_no;
  else
    new_no := 'LRS-RCP-' || lpad(nextval('public.acct_receipt_no_seq')::text, 6, '0');
    if t.receipt_no is null then
      update public.acct_transactions set receipt_no = new_no where id = t.id;
    end if;
  end if;

  snap := jsonb_build_object(
    'company', 'Larsa Engineering',
    'receipt_title', 'Funding Receipt / وصل استلام تمويل',
    'receipt_no', new_no,
    'kind', p_kind,
    'corrects_receipt_no', (select receipt_no from public.acct_receipts where id = p_corrects),
    'txn_no', t.txn_no,
    'txn_id', t.id,
    'project_id', proj.id,
    'project_code', proj.code,
    'project_name', proj.name,
    'client_name', coalesce(t.meta->>'payerName', proj.client),
    'payer_name', coalesce(t.meta->>'payerName', proj.client),
    'amount', t.original_amount,
    'currency', t.original_currency,
    'amount_iqd', t.amount_iqd,
    'amount_usd', t.amount_usd,
    'exchange_rate', t.exchange_rate,
    'rate_direction', 'USD_TO_IQD',
    'rate_source', t.rate_source,
    'txn_date', t.txn_date,
    'received_at', coalesce(t.posted_at, t.created_at),
    'payment_method', coalesce(t.meta->>'method',''),
    'payment_ref', coalesce(t.meta->>'referenceNumber', t.external_ref, ''),
    'fee_rate', coalesce(fee.fee_rate, (t.fee_rule->>'rate')::numeric),
    'fee_amount', coalesce(fee.fee_amount, 0),
    'fee_treatment', coalesce(fee.treatment, t.fee_rule->>'treatment'),
    'net_after_fee', case when coalesce(fee.treatment, t.fee_rule->>'treatment') = 'deduct_from_funding'
                          then round(t.original_amount - coalesce(fee.fee_amount,0), 2)
                          else t.original_amount end,
    'received_by', coalesce(t.meta->>'receivedBy', actor->>'name', ''),
    'entered_by_name', actor->>'name',
    'entered_by_email', lower(coalesce(actor->>'email','')),
    'entered_by_role', actor->>'role',
    'notes', coalesce(t.description,''),
    'review_status_at_issue', t.review_status,
    'timezone', coalesce(ps.display_timezone,'Asia/Baghdad'),
    'verify_code', upper(substr(md5(gen_random_uuid()::text), 1, 10)),
    'issued_at', now());

  insert into public.acct_receipts
    (receipt_no, txn_id, project_id, version, kind, corrects_receipt_id, snapshot,
     status_at_issue, is_sample, created_by)
  values
    (new_no, t.id, t.project_id, 1, p_kind, p_corrects, snap,
     t.review_status, t.is_sample, lower(coalesce(actor->>'email','')))
  returning * into row_r;

  if p_corrects is not null then
    update public.acct_receipts set corrected_by_receipt_id = row_r.id where id = p_corrects;
  end if;

  perform public.acct_log(actor, t.project_id, 'receipt', row_r.id::text,
    case when p_kind = 'corrected' then 'Corrected Receipt Issued' else 'Funding Receipt Issued' end,
    null, null, null, snap, new_no || ' for ' || t.txn_no);
  return jsonb_build_object('ok', true, 'receipt', to_jsonb(row_r));
end;
$$;

-- Record every print/reprint, with the approval status at that moment.
create or replace function public.acct_log_receipt_print(actor jsonb, p_receipt_id uuid, p_is_reprint boolean default false, p_reason text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare r record; t record; n int;
begin
  perform public.acct_check_perm(actor, case when p_is_reprint then 'reprint_receipts' else 'print_receipts' end);
  select * into r from public.acct_receipts where id = p_receipt_id;
  if r.id is null then raise exception 'ACCT_RECEIPT: not found'; end if;
  select * into t from public.acct_transactions where id = r.txn_id;
  select count(*) into n from public.acct_receipt_prints where receipt_id = r.id;
  insert into public.acct_receipt_prints
    (receipt_id, printed_by_email, printed_by_name, version, approval_status_at_print, is_reprint, reason)
  values
    (r.id, lower(coalesce(actor->>'email','')), actor->>'name', n + 1, t.review_status, p_is_reprint, p_reason);
  perform public.acct_log(actor, r.project_id, 'receipt', r.id::text,
    case when p_is_reprint then 'Receipt Reprinted' else 'Receipt Printed' end,
    p_reason, null, null, null,
    r.receipt_no || ' (print #' || (n + 1) || ', review status: ' || t.review_status || ')');
  return jsonb_build_object('ok', true, 'print_number', n + 1, 'current_review_status', t.review_status);
end;
$$;

-- ------------------------------------------------------------
-- 4. Review workflow: submit → review → approve / needs correction.
--    Approval never changes amounts, only the reliability status.
-- ------------------------------------------------------------
create or replace function public.acct_submit_for_review(actor jsonb, p_txn_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare t record; row_txn public.acct_transactions;
begin
  perform public.acct_check_perm(actor, 'submit_review');
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_REVIEW: transaction not found'; end if;
  if t.deleted_at is not null or t.status in ('void','reversed') then
    raise exception 'ACCT_REVIEW: inactive records cannot be submitted';
  end if;
  if t.review_status = 'approved' then
    raise exception 'ACCT_REVIEW: % is already approved', t.txn_no;
  end if;
  update public.acct_transactions
     set review_status = 'pending_review',
         review_submitted_at = now(),
         review_submitted_by = lower(coalesce(actor->>'email',''))
   where id = t.id returning * into row_txn;
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text, 'Submitted For Review',
    null, null, jsonb_build_object('review_status', t.review_status),
    jsonb_build_object('review_status', 'pending_review'), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

create or replace function public.acct_review_entry(actor jsonb, p_txn_id uuid, p_decision text, p_comment text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  t record; row_txn public.acct_transactions;
  selfrev boolean := false;
begin
  if p_decision not in ('approved','needs_correction') then
    raise exception 'ACCT_REVIEW: decision must be approved or needs_correction';
  end if;
  perform public.acct_check_perm(actor, case when p_decision = 'approved' then 'approve' else 'reject' end);
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_REVIEW: transaction not found'; end if;
  if t.deleted_at is not null or t.status in ('void','reversed') then
    raise exception 'ACCT_REVIEW: inactive records cannot be reviewed';
  end if;
  if p_decision = 'needs_correction' and coalesce(trim(p_comment),'') = '' then
    raise exception 'ACCT_REVIEW: a correction request requires a comment';
  end if;
  if p_decision = 'approved' and t.created_by_email = a_email then
    -- Self-approval is an explicit, separately-granted permission and is
    -- recorded permanently on the entry and in the audit history.
    if not public.acct_has_perm(actor, 'self_approve') then
      raise exception 'ACCT_REVIEW: you created this entry — a different authorized approver must approve it (self-approval requires an explicit permission)';
    end if;
    selfrev := true;
  end if;
  update public.acct_transactions
     set review_status = p_decision,
         reviewed_at = now(),
         reviewed_by = a_email,
         review_comment = p_comment,
         self_approved = selfrev
   where id = t.id returning * into row_txn;
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text,
    case when p_decision = 'approved' then 'Entry Approved' || case when selfrev then ' (SELF-APPROVED under explicit permission)' else '' end
         else 'Correction Requested' end,
    p_comment, null,
    jsonb_build_object('review_status', t.review_status),
    jsonb_build_object('review_status', p_decision), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

-- ------------------------------------------------------------
-- 5. Permission-aware replacements of the write entry points.
--    (Same behavior as part 2, plus: granular permissions, review
--    status lifecycle, automatic funding receipts, revision rules.)
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
  receipt_result jsonb := null;
  dup_count int;
  p_client_key uuid;
begin
  perform public.acct_check_perm(actor, 'create');

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

  p_client_key := nullif(txn->>'client_key','')::uuid;
  if p_client_key is not null then
    select * into row_txn from public.acct_transactions where client_key = p_client_key;
    if row_txn.id is not null then
      return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn), 'idempotent_replay', true);
    end if;
  end if;

  rate_res := public.acct_resolve_rate(proj.id, nullif(txn->>'exchange_rate','')::numeric);
  rate := (rate_res->>'rate')::numeric;
  rate_src := rate_res->>'source';
  if cur = 'IQD' then
    a_iqd := round(amt, 2); a_usd := round(amt / rate, 2);
  else
    a_usd := round(amt, 2); a_iqd := round(amt * rate, 2);
  end if;

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
     approved_by, approved_at, posted_at, review_status)
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
     case when st in ('posted','received','paid') then now() end,
     'unreviewed')
  returning * into row_txn;

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

  -- The client-ready funding receipt exists the moment the entry is saved —
  -- internal review never blocks proof that the money was received.
  if kind = 'funding' then
    receipt_result := public.acct_issue_receipt(actor, row_txn.id, 'original', null);
  end if;

  perform public.acct_log(actor, proj.id, kind, row_txn.id::text,
    initcap(kind) || ' Added', txn->>'reason', null, null, to_jsonb(row_txn),
    format('%s %s %s (%s) — rate %s (%s)', row_txn.txn_no, amt, cur, st, rate, rate_src));

  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn), 'fee', fee_result->'fee',
    'receipt', receipt_result->'receipt');
end;
$$;

create or replace function public.acct_update_transaction(actor jsonb, p_txn_id uuid, changes jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  t record;
  before jsonb;
  cur text;
  amt numeric(18,2);
  rate numeric(14,6);
  rate_src text;
  a_iqd numeric(18,2);
  a_usd numeric(18,2);
  rule jsonb;
  was_approved boolean := false;
  row_txn public.acct_transactions;
begin
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_TXN: not found'; end if;
  if t.status not in ('draft','pending') or t.deleted_at is not null then
    raise exception 'ACCT_IMMUTABLE: % is %; posted accounting records are corrected by reversal/replacement, not edited', t.txn_no, t.status;
  end if;
  -- Edit permissions: own unapproved vs any unapproved; a review-APPROVED
  -- entry needs the reopen permission and returns to Pending Review as a
  -- recorded revision — approved numbers never change silently.
  if t.created_by_email = a_email then
    perform public.acct_check_perm(actor, 'edit_own_unapproved');
  else
    perform public.acct_check_perm(actor, 'edit_any_unapproved');
  end if;
  if t.review_status = 'approved' then
    perform public.acct_check_perm(actor, 'reopen_approved');
    was_approved := true;
  end if;

  before := to_jsonb(t);
  cur := upper(coalesce(changes->>'currency', t.original_currency));
  amt := coalesce((changes->>'amount')::numeric, t.original_amount);

  if changes ? 'exchange_rate' and nullif(changes->>'exchange_rate','') is not null then
    rate := (changes->>'exchange_rate')::numeric; rate_src := 'transaction_override';
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
    meta = meta || coalesce(changes->'meta','{}'::jsonb),
    review_status = case when was_approved then 'pending_review' else review_status end,
    review_comment = case when was_approved then 'Revision of an approved entry — requires re-approval' else review_comment end
  where id = t.id
  returning * into row_txn;

  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text,
    case when was_approved then initcap(t.kind) || ' Revised (was approved — back to Pending Review)' else initcap(t.kind) || ' Edited' end,
    changes->>'reason', null, before, to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

-- ------------------------------------------------------------
-- 6. Project funding statement (server-computed; client renders/prints).
--    The full Working Total stays visible even when entries are pending.
-- ------------------------------------------------------------
create or replace function public.acct_funding_statement(p_project_id text, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  proj record; ps record;
  rows_j jsonb;
  totals record;
  refund_calc jsonb;
  pending_n int;
begin
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
$$;

-- ------------------------------------------------------------
-- 7. Working totals + aggregate review status in the project summary.
--    Working Total includes every ACTIVE entry (only void/reversed/
--    rejected/deleted are excluded). Approval changes the status
--    color, never the amount. The approved-basis figures used by the
--    fee, refund, and cost-progress rules are unchanged.
-- ------------------------------------------------------------
create or replace function public.acct_review_breakdown(p_project_id text)
returns jsonb
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  out jsonb := '{}'::jsonb;
  k text;
  r record;
  worst text;
  fee_status text;
begin
  for k in select unnest(array['funding','material','labor','expense','revenue','refund'])
  loop
    select
      coalesce(sum(amount_iqd),0) as working,
      coalesce(sum(amount_iqd) filter (where review_status = 'approved'),0) as approved,
      coalesce(sum(amount_iqd) filter (where review_status in ('unreviewed','pending_review')),0) as pending,
      coalesce(sum(amount_iqd) filter (where review_status = 'needs_correction'),0) as correction,
      count(*) filter (where review_status = 'needs_correction') as n_red,
      count(*) filter (where review_status in ('unreviewed','pending_review')) as n_yellow,
      count(*) as n_all
      into r
      from public.acct_transactions
     where project_id = p_project_id and kind = k
       and status not in ('void','reversed','rejected') and deleted_at is null;
    worst := case when r.n_red > 0 then 'red'
                  when r.n_yellow > 0 then 'yellow'
                  when r.n_all > 0 then 'green'
                  else null end;
    out := out || jsonb_build_object(k, jsonb_build_object(
      'working_iqd', round(r.working,2), 'approved_iqd', round(r.approved,2),
      'pending_iqd', round(r.pending,2), 'needs_correction_iqd', round(r.correction,2),
      'status', worst));
  end loop;

  -- Consultancy-fee total inherits the worst status of its source entries.
  select case when count(*) filter (where t.review_status = 'needs_correction') > 0 then 'red'
              when count(*) filter (where t.review_status in ('unreviewed','pending_review')) > 0 then 'yellow'
              when count(*) > 0 then 'green' else null end
    into fee_status
    from public.acct_fee_ledger f
    join public.acct_transactions t on t.id = f.source_txn_id
   where f.project_id = p_project_id and f.entry_type = 'fee' and f.status in ('posted','settled');
  out := out || jsonb_build_object('fee_status', fee_status);

  -- Cost totals (materials+labor+expense combined) drive the overall status.
  select case when count(*) filter (where review_status = 'needs_correction') > 0 then 'red'
              when count(*) filter (where review_status in ('unreviewed','pending_review')) > 0 then 'yellow'
              when count(*) > 0 then 'green' else null end
    into worst
    from public.acct_transactions
   where project_id = p_project_id
     and status not in ('void','reversed','rejected') and deleted_at is null;
  out := out || jsonb_build_object('overall_status', worst);
  return out;
end;
$$;

-- Extend the summary with the review layer (existing keys unchanged).
create or replace function public.acct_project_summary_v2(p_project_id text)
returns jsonb
language sql stable
security definer set search_path = public, pg_temp
as $$
  select public.acct_project_summary(p_project_id)
      || jsonb_build_object('review', public.acct_review_breakdown(p_project_id));
$$;

-- ------------------------------------------------------------
-- 8. Refunds respect the granular permissions.
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
  perform public.acct_check_perm(actor, 'post_refunds');
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
-- 8b. Sample removal also archives and removes sample receipts
--     (still never touching a single real record).
-- ------------------------------------------------------------
create or replace function public.acct_exec_remove_sample(actor jsonb, p_approval uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  snap jsonb;
  n_txn int; n_prj int;
begin
  snap := jsonb_build_object(
    'projects', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_projects x where x.is_sample),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_transactions x where x.is_sample),
    'fee_ledger', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_fee_ledger x where x.is_sample),
    'refund_settlements', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_refund_settlements x where x.is_sample),
    'receipts', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_receipts x where x.is_sample),
    'progress', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_progress_updates x where x.is_sample));
  insert into public.acct_archives (project_id, name, kind, snapshot, approval_id, created_by)
  values (null, 'Sample data removal ' || to_char(now(),'YYYY-MM-DD HH24:MI'), 'sample_removal', snap, p_approval,
          lower(coalesce(actor->>'email','')));

  select count(*) into n_txn from public.acct_transactions where is_sample;
  select count(*) into n_prj from public.acct_projects where is_sample;

  delete from public.acct_receipt_prints where receipt_id in (select id from public.acct_receipts where is_sample);
  delete from public.acct_receipts where is_sample;
  delete from public.acct_refund_settlements where is_sample;
  delete from public.acct_fee_ledger where is_sample;
  delete from public.acct_progress_updates where is_sample;
  delete from public.acct_transactions where is_sample;
  delete from public.acct_approval_requests where is_sample and id <> p_approval;
  delete from public.acct_review_queue where project_id in (select id from public.acct_projects where is_sample);
  delete from public.acct_projects where is_sample;

  update public.acct_platform_settings
     set sample_state = 'removed', sample_removed_at = now()
   where id = 1;

  perform public.acct_log(actor, null, 'sample_data', null, 'Sample Data Removed', null, p_approval, null, null,
    format('%s sample transactions across %s sample projects removed (including sample receipts); snapshot archived; sample data will not be seeded again', n_txn, n_prj));
  return jsonb_build_object('ok', true, 'removed_transactions', n_txn, 'removed_projects', n_prj);
end;
$$;

-- ------------------------------------------------------------
-- 9. Bootstrap: include receipts, permissions, and review data.
-- ------------------------------------------------------------
create or replace function public.acct_get_bootstrap(p_audit_limit int default 300)
returns jsonb
language sql
security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(x) from public.acct_platform_settings x where x.id = 1),
    'projects', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]'::jsonb) from public.acct_projects x),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.txn_date, x.created_at),'[]'::jsonb) from public.acct_transactions x),
    'fee_ledger', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]'::jsonb) from public.acct_fee_ledger x),
    'refund_settlements', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]'::jsonb) from public.acct_refund_settlements x),
    'progress', (select coalesce(jsonb_agg(to_jsonb(x) order by x.update_date),'[]'::jsonb) from public.acct_progress_updates x),
    'receipts', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at),'[]'::jsonb) from public.acct_receipts x),
    'permissions', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_permissions x),
    'approvals', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
                    from (select * from public.acct_approval_requests order by created_at desc limit 100) x),
    'review_queue', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
                    from (select * from public.acct_review_queue where status = 'open' order by created_at desc limit 200) x),
    'audit_recent', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb)
                    from (select * from public.acct_audit order by id desc limit p_audit_limit) x),
    'archives', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'project_id', x.project_id, 'name', x.name,
                    'kind', x.kind, 'created_by', x.created_by, 'created_at', x.created_at) order by x.created_at desc),'[]'::jsonb)
                    from public.acct_archives x));
$$;

-- ------------------------------------------------------------
-- 10. Backfill receipts for existing funding entries so statements
--     and reprints work for records created before this migration.
-- ------------------------------------------------------------
do $$
declare
  t record;
  sys jsonb := '{"email":"system@larsaeng.com","name":"Larsa Control","role":"Owner / Super Admin"}'::jsonb;
begin
  for t in select id from public.acct_transactions x
            where x.kind = 'funding' and x.deleted_at is null
              and x.status not in ('void','reversed','rejected')
              and not exists (select 1 from public.acct_receipts r where r.txn_id = x.id)
  loop
    perform public.acct_issue_receipt(sys, t.id, 'original', null);
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 11. Grants
-- ------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'acct_has_perm(jsonb,text)',
    'acct_get_my_permissions(text,text)',
    'acct_set_permissions(jsonb,text,text,jsonb,text)',
    'acct_issue_receipt(jsonb,uuid,text,uuid)',
    'acct_log_receipt_print(jsonb,uuid,boolean,text)',
    'acct_submit_for_review(jsonb,uuid)',
    'acct_review_entry(jsonb,uuid,text,text)',
    'acct_funding_statement(text,date,date)',
    'acct_review_breakdown(text)',
    'acct_project_summary_v2(text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  revoke all on function public.acct_check_perm(jsonb,text) from public, anon, authenticated;
  revoke all on function public.acct_role_default_perms(text) from public, anon;
  grant execute on function public.acct_role_default_perms(text) to authenticated;
end;
$$;
