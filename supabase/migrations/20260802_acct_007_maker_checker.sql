-- ============================================================
-- Larsa Control — Accounting upgrade, part 7: dual control
-- (maker-checker) on the PAYMENT status axis, with per-project and
-- per-area approver assignment.
--
-- The rule, as requested by the owner:
--   * The accountant PLUGS IN the data; a DIFFERENT person approves.
--     Every new entry is stored as PENDING APPROVAL no matter what
--     status the form sent (an explicit "Draft" stays a draft —
--     that is the entry person's own workspace).
--   * Moving an entry into a counted status (approved / posted /
--     received / paid) requires the 'approve' permission AND a
--     different user than the creator. Self-approval exists only as
--     the explicit, separately-granted 'self_approve' permission and
--     is recorded permanently (acct_transactions.self_approved).
--   * Each ACCOUNTING AREA (funding, material, labor, expense,
--     revenue, adjustment) may have assigned approvers
--     (platform_settings.area_approvers, set by the Platform Super
--     Admin with an email code). Each PROJECT may have assigned
--     data-entry accountants and assigned approvers
--     (acct_projects.assigned_accountants / assigned_approvers, set
--     in the project's accounting panel). Empty assignment = access
--     decides (any user holding the permission).
--   * Internal dual-controlled flows (protected corrections decided
--     by a second Platform Super Admin with a fresh email code, and
--     sample seeding) are exempt through a transaction-local flag
--     (acct.internal_op) outside callers cannot set: PostgREST runs
--     each RPC in its own transaction and no exposed function sets
--     the flag for a client.
--
-- Reversible: re-apply the part-2/part-6 function definitions and
-- drop the added columns to roll back. No data is rewritten.
-- ============================================================

create or replace function public.acct_internal_op()
returns boolean
language sql stable
set search_path = public, pg_temp
as $$ select coalesce(current_setting('acct.internal_op', true), '') = '1' $$;

alter table public.acct_platform_settings
  add column if not exists area_approvers jsonb not null default '{}'::jsonb;

alter table public.acct_projects
  add column if not exists assigned_accountants jsonb not null default '[]'::jsonb,
  add column if not exists assigned_approvers   jsonb not null default '[]'::jsonb;

-- Normalize a client-sent email list: array of lowercased, trimmed,
-- de-duplicated emails ('[]' when absent/invalid).
create or replace function public.acct_norm_email_list(p jsonb)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p is null or jsonb_typeof(p) <> 'array' then '[]'::jsonb
    else coalesce((select jsonb_agg(distinct e) from (
           select lower(trim(x)) as e from jsonb_array_elements_text(p) x
            where position('@' in x) > 0 and trim(x) <> '') s), '[]'::jsonb)
  end;
$$;

-- Normalize {kind: [emails]} keeping only real transaction kinds.
create or replace function public.acct_norm_area_approvers(p jsonb)
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select case when p is null or jsonb_typeof(p) <> 'object' then '{}'::jsonb
    else coalesce((select jsonb_object_agg(k, public.acct_norm_email_list(v))
                     from jsonb_each(p) as e(k, v)
                    where k in ('funding','material','labor','expense','revenue','adjustment')), '{}'::jsonb)
  end;
$$;

create or replace function public.acct_email_in_list(p_email text, p_list jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select p_list is not null and jsonb_typeof(p_list) = 'array'
     and exists (select 1 from jsonb_array_elements_text(p_list) x
                  where lower(trim(x)) = lower(coalesce(p_email,'')));
$$;

-- May this actor ENTER data for the project? Empty assignment = access
-- decides. Assigned approvers and the Owner / Super Admin role can
-- always enter (maker-checker still stops them approving their own
-- entries without the explicit self_approve grant).
create or replace function public.acct_check_entry_scope(actor jsonb, p_project_id text)
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  proj record;
begin
  select assigned_accountants, assigned_approvers, name into proj
    from public.acct_projects where id = p_project_id;
  if proj is null then return; end if;
  if jsonb_array_length(coalesce(proj.assigned_accountants,'[]'::jsonb)) = 0 then return; end if;
  if public.acct_email_in_list(a_email, proj.assigned_accountants)
     or public.acct_email_in_list(a_email, proj.assigned_approvers)
     or coalesce(actor->>'role','') = 'Owner / Super Admin' then
    return;
  end if;
  raise exception 'ACCT_SCOPE: data entry for project "%" is assigned to: % — ask an assigned accountant to record this entry',
    proj.name, (select string_agg(x, ', ') from jsonb_array_elements_text(proj.assigned_accountants) x);
end;
$$;

-- Does this actor match the approver ASSIGNMENT for the project and
-- area? (The 'approve' permission itself is checked separately —
-- assignment only narrows who may use it; it never grants it.)
create or replace function public.acct_approver_scope_ok(actor jsonb, p_project_id text, p_kind text)
returns boolean
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  proj_list jsonb;
  area_list jsonb;
begin
  select assigned_approvers into proj_list from public.acct_projects where id = p_project_id;
  if proj_list is not null and jsonb_array_length(coalesce(proj_list,'[]'::jsonb)) > 0
     and not public.acct_email_in_list(a_email, proj_list) then
    return false;
  end if;
  select area_approvers->p_kind into area_list from public.acct_platform_settings where id = 1;
  if area_list is not null and jsonb_typeof(area_list) = 'array'
     and jsonb_array_length(area_list) > 0
     and not public.acct_email_in_list(a_email, area_list) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.acct_check_approver_scope(actor jsonb, p_project_id text, p_kind text)
returns void
language plpgsql stable
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  proj record;
  area_list jsonb;
begin
  select name, assigned_approvers into proj from public.acct_projects where id = p_project_id;
  if proj is not null and jsonb_array_length(coalesce(proj.assigned_approvers,'[]'::jsonb)) > 0
     and not public.acct_email_in_list(a_email, proj.assigned_approvers) then
    raise exception 'ACCT_SCOPE: approval for project "%" is assigned to: % — an assigned approver must decide this entry',
      proj.name, (select string_agg(x, ', ') from jsonb_array_elements_text(proj.assigned_approvers) x);
  end if;
  select area_approvers->p_kind into area_list from public.acct_platform_settings where id = 1;
  if area_list is not null and jsonb_typeof(area_list) = 'array' and jsonb_array_length(area_list) > 0
     and not public.acct_email_in_list(a_email, area_list) then
    raise exception 'ACCT_SCOPE: approval for the % area is assigned to: % — an assigned approver must decide this entry',
      p_kind, (select string_agg(x, ', ') from jsonb_array_elements_text(area_list) x);
  end if;
end;
$$;

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
  st   text := lower(coalesce(txn->>'status','pending'));
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
  requested_st text;
  forced_pending boolean := false;
  self_ok boolean := false;
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

  -- ------------------------------------------------------------
  -- Dual control (maker-checker). The person who ENTERS an entry
  -- never also makes it count:
  --   * data entry may be limited per project (assigned accountants);
  --   * a requested counted status (approved/posted/received/paid)
  --     is stored as PENDING APPROVAL instead — a DIFFERENT user
  --     holding 'approve' (and matching the project/area approver
  --     assignment, when one is set) approves it as a separate act;
  --   * the only exception is the explicit, separately-granted and
  --     permanently recorded 'self_approve' permission;
  --   * internal dual-controlled flows (protected corrections,
  --     sample seeding) are exempt via a transaction-local flag
  --     outside callers cannot set.
  -- ------------------------------------------------------------
  if not public.acct_internal_op() then
    perform public.acct_check_entry_scope(actor, proj.id);
  end if;
  requested_st := st;
  if st in ('approved','posted','received','paid') and not public.acct_internal_op() then
    if public.acct_has_perm(actor, 'approve') and public.acct_has_perm(actor, 'self_approve')
       and public.acct_approver_scope_ok(actor, proj.id, kind) then
      self_ok := true;
    else
      st := 'pending';
      forced_pending := true;
    end if;
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
     approved_by, approved_at, posted_at, review_status, self_approved)
  values
    (new_no, new_receipt, proj.id, kind, txn->>'category', txn->>'description', txn->>'supplier',
     nullif(txn->>'quantity','')::numeric, txn->>'unit',
     coalesce(nullif(txn->>'date','')::date, current_date), st, txn->>'payment_source',
     round(amt,2), cur, rate, 'USD_TO_IQD',
     coalesce(nullif(txn->>'rate_date','')::date, coalesce(nullif(txn->>'date','')::date, current_date)),
     rate_src, txn->>'rate_note', coalesce(actor->>'email',''), a_iqd, a_usd, rule,
     coalesce((txn->>'is_sample')::boolean, false), p_client_key,
     nullif(txn->>'external_ref',''), nullif(txn->>'attachment_path',''),
     coalesce(txn->'meta','{}'::jsonb)
       || case when forced_pending then jsonb_build_object('requested_status', requested_st, 'approval_policy', 'maker_checker') else '{}'::jsonb end,
     lower(coalesce(actor->>'email','')), actor->>'name', actor->>'role',
     case when st in ('approved','posted','received','paid') then lower(coalesce(actor->>'email','')) end,
     case when st in ('approved','posted','received','paid') then now() end,
     case when st in ('posted','received','paid') then now() end,
     'unreviewed', self_ok)
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
    format('%s %s %s (%s) — rate %s (%s)%s', row_txn.txn_no, amt, cur, st, rate, rate_src,
      case when forced_pending then ' — entered as PENDING APPROVAL; a different authorized user approves it'
           when self_ok then ' — SELF-APPROVED under explicit permission' else '' end));

  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn), 'fee', fee_result->'fee',
    'receipt', receipt_result->'receipt', 'entered_pending', forced_pending);
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
  if not public.acct_internal_op() then
    perform public.acct_check_entry_scope(actor, t.project_id);
  end if;
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
  self_flag boolean := false;
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

  -- Dual control on the payment axis: only a user holding 'approve' —
  -- and matching the project / area approver assignment when one is
  -- set — moves an entry into a counted status, and never the user
  -- who entered it (unless explicitly granted the recorded
  -- 'self_approve' permission). Rejecting requires 'reject'.
  if p_status in ('approved','posted','received','paid') and not public.acct_internal_op() then
    perform public.acct_check_perm(actor, 'approve');
    perform public.acct_check_approver_scope(actor, t.project_id, t.kind);
    if lower(coalesce(actor->>'email','')) = coalesce(t.created_by_email,'') then
      if not public.acct_has_perm(actor, 'self_approve') then
        raise exception 'ACCT_APPROVAL: you entered % — a different authorized user must approve it (self-approval requires an explicit permission)', t.txn_no;
      end if;
      self_flag := true;
    end if;
  elsif p_status = 'rejected' and not public.acct_internal_op() then
    perform public.acct_check_perm(actor, 'reject');
    perform public.acct_check_approver_scope(actor, t.project_id, t.kind);
  end if;

  new_receipt := t.receipt_no;
  if p_status in ('approved','posted','received','paid') and t.receipt_no is null then
    new_receipt := 'LRS-RCP-' || lpad(nextval('public.acct_receipt_no_seq')::text, 6, '0');
  end if;

  update public.acct_transactions set
    status = p_status,
    receipt_no = new_receipt,
    approved_by = case when p_status in ('approved','posted','received','paid') then lower(coalesce(actor->>'email','')) else approved_by end,
    self_approved = case when p_status in ('approved','posted','received','paid') then self_flag else self_approved end,
    approved_at = case when p_status in ('approved','posted','received','paid') then now() else approved_at end,
    posted_at = case when p_status in ('posted','received','paid') then now() else posted_at end
  where id = t.id
  returning * into row_txn;

  perform public.acct_sync_fee_for_txn(actor, t.id);
  perform public.acct_log(actor, t.project_id, t.kind, t.id::text,
    case when p_status = 'rejected' then initcap(t.kind) || ' Rejected' else initcap(t.kind) || ' ' || initcap(p_status) || case when self_flag then ' (SELF-APPROVED under explicit permission)' else '' end end,
    p_note, null, before, to_jsonb(row_txn), row_txn.txn_no);
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
  if not public.acct_internal_op() then
    perform public.acct_check_approver_scope(actor, t.project_id, t.kind);
  end if;
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
     fee_treatment, fee_category_overrides, assigned_accountants, assigned_approvers, is_sample, legacy_id, created_by)
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
     public.acct_norm_email_list(p->'assigned_accountants'), public.acct_norm_email_list(p->'assigned_approvers'),
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
    fee_category_overrides = case when p ? 'fee_category_overrides' then p->'fee_category_overrides' else ap.fee_category_overrides end,
    assigned_accountants = case when p ? 'assigned_accountants' then public.acct_norm_email_list(p->'assigned_accountants') else ap.assigned_accountants end,
    assigned_approvers = case when p ? 'assigned_approvers' then public.acct_norm_email_list(p->'assigned_approvers') else ap.assigned_approvers end
  returning * into row_p;

  perform public.acct_log(actor, row_p.id, 'project', row_p.id,
    case when before is null then 'Project Added' else 'Project Accounting Settings Edited' end,
    p->>'reason', null, before, to_jsonb(row_p), row_p.name);
  return jsonb_build_object('ok', true, 'project', to_jsonb(row_p));
end;
$$;

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
    area_approvers = case when changes ? 'area_approvers' then public.acct_norm_area_approvers(changes->'area_approvers') else area_approvers end,
    updated_by = a_email
  where id = 1
  returning * into row_s;

  perform public.acct_log(actor, null, 'platform_settings', '1', 'Platform Accounting Defaults Changed',
    changes->>'reason', null, before, to_jsonb(row_s),
    'Defaults apply to FUTURE transactions only; historical snapshots are never recalculated');
  return jsonb_build_object('ok', true, 'settings', to_jsonb(row_s));
end;
$$;

create or replace function public.acct_decide_approval(actor jsonb, p_code text, p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
#variable_conflict use_variable
declare
  a_email text := lower(coalesce(actor->>'email',''));
  req record;
  result jsonb := '{}'::jsonb;
  t record;
  new_txn jsonb;
begin
  -- Internal dual-controlled flow: exempt from maker-checker / scope rules.
  perform set_config('acct.internal_op', '1', true);
  select * into req from public.acct_approval_requests where id = p_request_id;
  if req.id is null then raise exception 'ACCT_APPROVAL: request not found'; end if;
  if req.status <> 'pending' then raise exception 'ACCT_APPROVAL: request is already %', req.status; end if;
  if not public.acct_is_platform_admin(a_email) then
    raise exception 'ACCT_FORBIDDEN: only the Platform Super Admin may decide protected accounting actions';
  end if;
  if a_email = lower(req.requester_email) then
    raise exception 'ACCT_FORBIDDEN: self-approval is not permitted — a different Platform Super Admin must decide';
  end if;
  perform public.acct_consume_email_code(a_email, p_code);

  if not p_approve then
    update public.acct_approval_requests
       set status = 'rejected', approver_email = a_email, approver_note = p_note, decided_at = now()
     where id = req.id;
    perform public.acct_log(actor, req.project_id, 'approval_request', req.id::text,
      'Protected Action Rejected: ' || req.action, p_note, req.id, null, null,
      'Requested by ' || req.requester_email);
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  update public.acct_approval_requests
     set status = 'approved', approver_email = a_email, approver_note = p_note, decided_at = now()
   where id = req.id;

  begin
    case req.action
      when 'remove_sample_data' then
        result := public.acct_exec_remove_sample(actor, req.id);
      when 'void_posted_transaction' then
        result := public.acct_exec_void_txn(actor, (req.payload->>'txn_id')::uuid, req.reason, req.id);
      when 'post_refund' then
        result := public.acct_execute_refund(actor, (req.payload->>'settlement_id')::uuid, req.id);
        if result->>'ok' = 'false' then
          update public.acct_approval_requests set status = 'failed', result = result, executed_at = now() where id = req.id;
          return jsonb_build_object('ok', false, 'status', 'failed', 'result', result);
        end if;
      when 'project_reset' then
        result := public.acct_exec_project_reset(actor, req.project_id, req.reason, req.id, false);
      when 'project_delete' then
        result := public.acct_exec_project_reset(actor, req.project_id, req.reason, req.id, true);
      when 'bulk_delete' then
        declare txn_id text; c int := 0;
        begin
          for txn_id in select jsonb_array_elements_text(coalesce(req.payload->'txn_ids','[]'::jsonb))
          loop
            select * into t from public.acct_transactions where id = txn_id::uuid;
            if t.id is null then continue; end if;
            if t.status in ('draft','pending','rejected') then
              update public.acct_transactions
                 set deleted_at = now(), deleted_by = a_email, delete_reason = req.reason
               where id = t.id;
              update public.acct_fee_ledger set status='void' where source_txn_id = t.id and entry_type='fee' and status='estimated';
              perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind)||' Deleted (soft, bulk)', req.reason, req.id, to_jsonb(t), null, t.txn_no);
            else
              perform public.acct_exec_void_txn(actor, t.id, req.reason, req.id);
            end if;
            c := c + 1;
          end loop;
          result := jsonb_build_object('ok', true, 'processed', c);
        end;
      when 'change_historical_rate' then
        -- Never rewrite history: void the original and repost a linked
        -- replacement carrying the corrected rate snapshot.
        select * into t from public.acct_transactions where id = (req.payload->>'txn_id')::uuid;
        if t.id is null then raise exception 'ACCT: transaction not found'; end if;
        result := public.acct_exec_void_txn(actor, t.id, 'Historical rate correction: ' || req.reason, req.id);
        new_txn := public.acct_post_transaction(actor, jsonb_build_object(
          'project_id', t.project_id, 'kind', t.kind, 'category', t.category,
          'description', coalesce(t.description,'') || ' [rate-corrected replacement of ' || t.txn_no || ']',
          'supplier', t.supplier, 'quantity', t.quantity, 'unit', t.unit,
          'date', t.txn_date, 'status', t.status, 'payment_source', t.payment_source,
          'amount', t.original_amount, 'currency', t.original_currency,
          'exchange_rate', (req.payload->>'new_rate')::numeric,
          'rate_note', 'Approved historical-rate correction (was ' || t.exchange_rate || ')',
          'fee_override', t.fee_rule, 'is_sample', t.is_sample,
          'meta', jsonb_build_object('replacement_of', t.id)));
        update public.acct_transactions set reversed_by_txn = ((new_txn->'txn')->>'id')::uuid where id = t.id;
        result := result || jsonb_build_object('replacement', new_txn->'txn');
      when 'change_historical_fee_rule' then
        select * into t from public.acct_transactions where id = (req.payload->>'txn_id')::uuid;
        if t.id is null then raise exception 'ACCT: transaction not found'; end if;
        result := public.acct_exec_void_txn(actor, t.id, 'Historical fee-rule correction: ' || req.reason, req.id);
        new_txn := public.acct_post_transaction(actor, jsonb_build_object(
          'project_id', t.project_id, 'kind', t.kind, 'category', t.category,
          'description', coalesce(t.description,'') || ' [fee-corrected replacement of ' || t.txn_no || ']',
          'supplier', t.supplier, 'quantity', t.quantity, 'unit', t.unit,
          'date', t.txn_date, 'status', t.status, 'payment_source', t.payment_source,
          'amount', t.original_amount, 'currency', t.original_currency,
          'exchange_rate', t.exchange_rate,
          'rate_note', t.rate_note,
          'fee_override', req.payload->'new_fee_rule', 'is_sample', t.is_sample,
          'meta', jsonb_build_object('replacement_of', t.id)));
        update public.acct_transactions set reversed_by_txn = ((new_txn->'txn')->>'id')::uuid where id = t.id;
        result := result || jsonb_build_object('replacement', new_txn->'txn');
      when 'restore_record' then
        select * into t from public.acct_transactions where id = (req.payload->>'txn_id')::uuid;
        if t.id is null then raise exception 'ACCT: transaction not found'; end if;
        update public.acct_transactions
           set status = coalesce(req.payload->>'prior_status','posted'), void_reason = null, deleted_at = null
         where id = t.id;
        perform public.acct_sync_fee_for_txn(actor, t.id);
        perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind) || ' Restored (approved)',
          req.reason, req.id, to_jsonb(t), null, t.txn_no);
        result := jsonb_build_object('ok', true);
      when 'restore_version' then
        result := public.acct_exec_restore_version(actor, (req.payload->>'archive_id')::uuid, req.id);
      when 'replace_from_backup' then
        -- Archive current live accounting data, then merge the supplied
        -- backup through the legacy importer. Nothing is physically erased.
        insert into public.acct_archives (name, kind, snapshot, approval_id, created_by)
        values ('Pre-replacement archive ' || to_char(now(),'YYYY-MM-DD HH24:MI'), 'backup_replace',
          jsonb_build_object(
            'projects', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_projects x),
            'transactions', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_transactions x),
            'fee_ledger', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_fee_ledger x)),
          req.id, a_email);
        result := public.acct_import_legacy(actor, req.payload->'backup');
      else
        raise exception 'ACCT_APPROVAL: unknown action %', req.action;
    end case;

    update public.acct_approval_requests
       set status = 'executed', executed_at = now(), result = result
     where id = req.id;
  exception when others then
    update public.acct_approval_requests
       set status = 'failed', executed_at = now(),
           result = jsonb_build_object('error', sqlerrm)
     where id = req.id;
    perform public.acct_log(actor, req.project_id, 'approval_request', req.id::text,
      'Protected Action FAILED: ' || req.action, sqlerrm, req.id, null, null, null);
    return jsonb_build_object('ok', false, 'status', 'failed', 'error', sqlerrm);
  end;

  perform public.acct_log(actor, req.project_id, 'approval_request', req.id::text,
    'Protected Action Approved & Executed: ' || req.action, p_note, req.id, null, result,
    'Requested by ' || req.requester_email || '; decided by ' || a_email);
  return jsonb_build_object('ok', true, 'status', 'executed', 'result', result);
end;
$$;

create or replace function public.acct_seed_sample_data(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  ps record;
  real_projects int;
  real_txns int;
  sys jsonb := jsonb_build_object('email', coalesce(nullif(actor->>'email',''),'system@larsaeng.com'),
                                  'name', coalesce(nullif(actor->>'name',''),'Larsa Control'),
                                  'role', 'Owner / Super Admin');
  p1 text := 'prj_sample_villa';
  p2 text := 'prj_sample_alnoor';
  p3 text := 'prj_sample_warehouse';
  r jsonb;
  f1 jsonb; f2 jsonb;
  settle jsonb;
begin
  -- Internal dual-controlled flow: exempt from maker-checker / scope rules.
  perform set_config('acct.internal_op', '1', true);
  select * into ps from public.acct_platform_settings where id = 1;
  if ps.sample_state <> 'never_seeded' then
    return jsonb_build_object('ok', false, 'skipped', ps.sample_state);
  end if;
  select count(*) into real_projects from public.acct_projects where not is_sample;
  select count(*) into real_txns from public.acct_transactions where not is_sample;
  if real_projects > 0 or real_txns > 0 then
    return jsonb_build_object('ok', false, 'skipped', 'organization has real accounting records');
  end if;

  -- P1: IQD project, 8% funding-based fee deducted from funding (platform default).
  perform public.acct_upsert_project(sys, jsonb_build_object(
    'id', p1, 'code', 'SMP-IRQ-001', 'name', 'Sample — Mosul Private Villa', 'client', 'Sample Client A',
    'currency', 'IQD', 'contract_value', 200000000, 'approved_budget', 100000000, 'budget_currency', 'IQD',
    'is_sample', true));
  update public.acct_projects set is_sample = true where id = p1;

  f1 := public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind', 'funding',
    'category','Client Funding','description','Initial funding instalment','amount', 10000000, 'currency','IQD',
    'date', (current_date - 90)::text, 'status','received','is_sample', true));
  f2 := public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind', 'funding',
    'category','Client Funding','description','Additional funding instalment','amount', 2000000, 'currency','IQD',
    'date', (current_date - 45)::text, 'status','received','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind','material',
    'category','Concrete & Steel','supplier','Sample Supplier Co.','description','Foundation materials',
    'quantity', 120, 'unit','m3','amount', 3000000,'currency','IQD','date',(current_date - 60)::text,'status','approved','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind','labor',
    'category','Skilled Labor','description','Foundation crew — 3 weeks','amount', 2500000,'currency','IQD',
    'date',(current_date - 50)::text,'status','approved','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind','expense',
    'category','Equipment Rental','description','Crane rental','amount', 1500000,'currency','IQD',
    'date',(current_date - 40)::text,'status','approved','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p1, 'kind','expense',
    'category','Permits','description','Municipal permit (pending)','amount', 400000,'currency','IQD',
    'date',(current_date - 10)::text,'status','pending','is_sample', true));
  perform public.acct_record_progress(sys, p1, 35, current_date - 30, 'Foundation complete (sample)');
  perform public.acct_record_progress(sys, p1, 45, current_date - 7, 'Ground-floor columns poured (sample)');

  -- P2: USD project demonstrating DIFFERENT historical exchange rates
  -- (1,000 USD at 1,500 + 1,000 USD at 1,600 = IQD 3,100,000 forever),
  -- with an expense-based fee recorded as separate Larsa revenue.
  perform public.acct_upsert_project(sys, jsonb_build_object(
    'id', p2, 'code', 'SMP-IRQ-002', 'name', 'Sample — Al-Noor Commercial Fit-out', 'client', 'Sample Client B',
    'currency', 'USD', 'contract_value', 50000, 'approved_budget', 30000, 'budget_currency', 'USD',
    'fee_inherit', false, 'fee_method', 'percentage', 'fee_rate', 0.08,
    'fee_basis', 'total_expenses', 'fee_treatment', 'larsa_revenue', 'is_sample', true));
  update public.acct_projects set is_sample = true where id = p2;

  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p2, 'kind','funding',
    'category','Client Funding','description','Mobilization payment (historical rate 1500)',
    'amount', 1000, 'currency','USD','exchange_rate', 1500,
    'date',(current_date - 200)::text,'status','received','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p2, 'kind','funding',
    'category','Client Funding','description','Second payment (historical rate 1600)',
    'amount', 1000, 'currency','USD','exchange_rate', 1600,
    'date',(current_date - 120)::text,'status','received','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p2, 'kind','material',
    'category','Finishes','supplier','Sample Interiors Ltd.','description','Flooring package',
    'amount', 400,'currency','USD','exchange_rate', 1500,'date',(current_date - 150)::text,'status','approved','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p2, 'kind','labor',
    'category','Skilled Labor','description','Fit-out crew','amount', 300,'currency','USD','exchange_rate', 1600,
    'date',(current_date - 100)::text,'status','approved','is_sample', true));
  perform public.acct_record_progress(sys, p2, 20, current_date - 90, 'Fit-out started (sample)');

  -- P3: fixed-per-project fee charged as a project expense, plus a posted
  -- partial refund of unused funding (with its approval trail).
  perform public.acct_upsert_project(sys, jsonb_build_object(
    'id', p3, 'code', 'SMP-IRQ-003', 'name', 'Sample — Erbil Warehouse', 'client', 'Sample Client C',
    'currency', 'IQD', 'contract_value', 60000000, 'approved_budget', 40000000, 'budget_currency', 'IQD',
    'fee_inherit', false, 'fee_method', 'fixed_per_project', 'fee_fixed', 1500000,
    'fee_basis', 'funding', 'fee_treatment', 'project_expense', 'is_sample', true));
  update public.acct_projects set is_sample = true where id = p3;

  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p3, 'kind','funding',
    'category','Client Funding','description','Full advance','amount', 20000000,'currency','IQD',
    'date',(current_date - 300)::text,'status','received','is_sample', true));
  perform public.acct_post_transaction(sys, jsonb_build_object('project_id', p3, 'kind','expense',
    'category','Sitework','description','Grading and drainage','amount', 5000000,'currency','IQD',
    'date',(current_date - 250)::text,'status','approved','is_sample', true));
  perform public.acct_record_progress(sys, p3, 100, current_date - 60, 'Handover complete (sample)');

  settle := public.acct_create_refund_settlement(sys, p3, 2000000, null, null,
    'Sample partial refund of unused funding');
  insert into public.acct_approval_requests
    (action, project_id, payload, impact, reason, requester_email, requester_name, requester_role,
     requester_verified_at, status, approver_email, decided_at, executed_at, is_sample)
  values ('post_refund', p3,
     jsonb_build_object('settlement_id', (settle->'settlement'->>'id'), 'is_sample', true),
     jsonb_build_object('total_refund_iqd', (settle->'settlement'->>'total_refund')),
     'Sample refund approval (demonstration)', 'sample.accountant@larsaeng.com', 'Sample Accountant', 'Accountant',
     now(), 'approved', 'sample.owner@larsaeng.com', now(), now(), true);
  perform public.acct_execute_refund(sys, ((settle->'settlement'->>'id'))::uuid, null);

  update public.acct_platform_settings
     set sample_state = 'seeded', sample_seeded_at = now() where id = 1;
  perform public.acct_log(sys, null, 'sample_data', null, 'Sample Accounting Data Seeded', null, null, null, null,
    'Realistic sample projects, funding, materials, labor, expenses, consultancy fees, historical exchange rates, progress, receipts, approvals, and a refund — all marked as sample records');
  return jsonb_build_object('ok', true);
end;
$$;
