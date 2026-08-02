-- ============================================================
-- Larsa Control — Accounting upgrade, part 4:
-- protected destructive-action workflow, sample data lifecycle,
-- legacy blob import, and the engine bootstrap fetch.
-- ============================================================

alter table public.acct_approval_requests add column if not exists is_sample boolean not null default false;

-- ------------------------------------------------------------
-- Step 1+2+3+4+5 of the protected workflow: the accountant initiates,
-- proves the mailbox with a FRESH emailed code (sent through the
-- existing auth-code Edge Function; the app also re-checks the local
-- password before calling), states a reason, and the affected records
-- + financial impact are computed and stored for the approver.
-- ------------------------------------------------------------
create or replace function public.acct_request_protected(
  actor jsonb, p_code text, p_action text, p_project_id text,
  p_payload jsonb, p_reason text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
  impact jsonb := '{}'::jsonb;
  t record;
  s record;
  n int;
  amt numeric;
  req public.acct_approval_requests;
begin
  perform public.acct_check_actor(actor, 'write');
  if coalesce(trim(p_reason),'') = '' then
    raise exception 'ACCT_PROTECTED: a reason is required';
  end if;
  perform public.acct_consume_email_code(a_email, p_code);

  if p_action = 'void_posted_transaction' or p_action = 'change_historical_rate' or p_action = 'change_historical_fee_rule' or p_action = 'restore_record' then
    select * into t from public.acct_transactions where id = nullif(p_payload->>'txn_id','')::uuid;
    if t.id is null then raise exception 'ACCT_PROTECTED: transaction not found'; end if;
    impact := jsonb_build_object('txn_no', t.txn_no, 'kind', t.kind, 'status', t.status,
      'amount', t.original_amount, 'currency', t.original_currency,
      'amount_iqd', t.amount_iqd, 'amount_usd', t.amount_usd, 'project_id', t.project_id,
      'posted_fee', (select fee_amount from public.acct_fee_ledger
                      where source_txn_id = t.id and entry_type='fee' and status in ('posted','settled') limit 1));
  elsif p_action = 'post_refund' then
    select * into s from public.acct_refund_settlements where id = nullif(p_payload->>'settlement_id','')::uuid;
    if s.id is null then raise exception 'ACCT_PROTECTED: refund settlement not found'; end if;
    update public.acct_refund_settlements set status = 'pending_approval' where id = s.id and status = 'draft';
    impact := jsonb_build_object('project_id', s.project_id,
      'unused_net_funding_iqd', s.unused_net_funding, 'refundable_fee_iqd', s.refundable_fee,
      'total_refund_iqd', s.total_refund, 'retained_fee_iqd', s.retained_fee, 'partial', s.partial);
  elsif p_action in ('project_reset','project_delete') then
    select count(*), coalesce(sum(amount_iqd) filter (where status = any (public.acct_actual_statuses(kind))),0)
      into n, amt from public.acct_transactions where project_id = p_project_id and deleted_at is null;
    impact := jsonb_build_object('project_id', p_project_id, 'live_transactions', n, 'posted_amount_iqd', amt);
  elsif p_action = 'remove_sample_data' then
    select count(*) into n from public.acct_transactions where is_sample;
    impact := jsonb_build_object('sample_transactions', n,
      'sample_projects', (select count(*) from public.acct_projects where is_sample),
      'note', 'Only records marked as sample data are affected; real records are never touched');
  elsif p_action = 'bulk_delete' then
    select count(*), coalesce(sum(amount_iqd),0) into n, amt
      from public.acct_transactions
     where id in (select (jsonb_array_elements_text(coalesce(p_payload->'txn_ids','[]'::jsonb)))::uuid);
    impact := jsonb_build_object('records', n, 'amount_iqd', amt);
  elsif p_action in ('replace_from_backup','restore_version') then
    impact := jsonb_build_object('archive_id', p_payload->>'archive_id',
      'note', 'Current data is archived before any replacement; nothing is physically erased');
  end if;

  insert into public.acct_approval_requests
    (action, project_id, payload, impact, reason,
     requester_email, requester_name, requester_role, requester_verified_at, is_sample)
  values
    (p_action, p_project_id, coalesce(p_payload,'{}'::jsonb), impact, p_reason,
     a_email, actor->>'name', actor->>'role', now(), coalesce((p_payload->>'is_sample')::boolean,false))
  returning * into req;

  perform public.acct_log(actor, p_project_id, 'approval_request', req.id::text,
    'Protected Action Requested: ' || p_action, p_reason, req.id, null, to_jsonb(req), null);
  return jsonb_build_object('ok', true, 'request', to_jsonb(req));
end;
$$;

-- ------------------------------------------------------------
-- Internal executors (called only from acct_decide_approval).
-- ------------------------------------------------------------
create or replace function public.acct_exec_void_txn(actor jsonb, p_txn_id uuid, p_reason text, p_approval uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare t record; fee record; row_txn public.acct_transactions;
begin
  select * into t from public.acct_transactions where id = p_txn_id;
  if t.id is null then raise exception 'ACCT_VOID: transaction not found'; end if;
  if t.status in ('void','reversed') then return jsonb_build_object('ok', true, 'already', t.status); end if;

  update public.acct_transactions
     set status = 'void', void_reason = p_reason
   where id = t.id returning * into row_txn;

  -- Reverse (never delete) any posted fee generated by this transaction.
  for fee in select * from public.acct_fee_ledger
              where source_txn_id = t.id and entry_type = 'fee' and status in ('posted','settled')
  loop
    insert into public.acct_fee_ledger
      (project_id, source_txn_id, entry_type, calc_method, fee_rate, fixed_amount, calc_basis,
       basis_amount, fee_amount, currency, exchange_rate, fee_iqd, fee_usd, treatment,
       config_source, status, is_sample, reversal_of, note, created_by, approved_by)
    values
      (fee.project_id, t.id, 'fee_reversal', fee.calc_method, fee.fee_rate, fee.fixed_amount, fee.calc_basis,
       -fee.basis_amount, -fee.fee_amount, fee.currency, fee.exchange_rate, -fee.fee_iqd, -fee.fee_usd,
       fee.treatment, fee.config_source, 'posted', fee.is_sample, fee.id,
       'Fee reversed with voided transaction ' || t.txn_no, lower(coalesce(actor->>'email','')), lower(coalesce(actor->>'email','')));
    update public.acct_fee_ledger set status = 'reversed', provisional = false where id = fee.id;
  end loop;
  update public.acct_fee_ledger set status = 'void'
   where source_txn_id = t.id and entry_type = 'fee' and status = 'estimated';

  perform public.acct_log(actor, t.project_id, t.kind, t.id::text, initcap(t.kind) || ' Voided',
    p_reason, p_approval, to_jsonb(t), to_jsonb(row_txn), row_txn.txn_no);
  return jsonb_build_object('ok', true, 'txn', to_jsonb(row_txn));
end;
$$;

create or replace function public.acct_exec_remove_sample(actor jsonb, p_approval uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  snap jsonb;
  n_txn int; n_prj int;
begin
  -- Complete archive first: sample removal is itself restorable.
  snap := jsonb_build_object(
    'projects', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_projects x where x.is_sample),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_transactions x where x.is_sample),
    'fee_ledger', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_fee_ledger x where x.is_sample),
    'refund_settlements', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_refund_settlements x where x.is_sample),
    'progress', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_progress_updates x where x.is_sample));
  insert into public.acct_archives (project_id, name, kind, snapshot, approval_id, created_by)
  values (null, 'Sample data removal ' || to_char(now(),'YYYY-MM-DD HH24:MI'), 'sample_removal', snap, p_approval,
          lower(coalesce(actor->>'email','')));

  select count(*) into n_txn from public.acct_transactions where is_sample;
  select count(*) into n_prj from public.acct_projects where is_sample;

  -- Strictly is_sample-only deletes: real records can never be touched here.
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
    format('%s sample transactions across %s sample projects removed; snapshot archived; sample data will not be seeded again', n_txn, n_prj));
  return jsonb_build_object('ok', true, 'removed_transactions', n_txn, 'removed_projects', n_prj);
end;
$$;

create or replace function public.acct_exec_project_reset(actor jsonb, p_project_id text, p_reason text, p_approval uuid, p_delete boolean default false)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  snap jsonb;
  t record;
  n int := 0;
begin
  -- Complete financial snapshot before anything changes.
  snap := jsonb_build_object(
    'project', (select to_jsonb(x) from public.acct_projects x where x.id = p_project_id),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_transactions x where x.project_id = p_project_id),
    'fee_ledger', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_fee_ledger x where x.project_id = p_project_id),
    'refund_settlements', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_refund_settlements x where x.project_id = p_project_id),
    'progress', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.acct_progress_updates x where x.project_id = p_project_id),
    'summary', public.acct_project_summary(p_project_id));
  insert into public.acct_archives (project_id, name, kind, snapshot, approval_id, created_by)
  values (p_project_id,
          (case when p_delete then 'Project delete: ' else 'Project reset: ' end) || p_project_id || ' ' || to_char(now(),'YYYY-MM-DD HH24:MI'),
          'project_reset', snap, p_approval, lower(coalesce(actor->>'email','')));

  for t in select * from public.acct_transactions
            where project_id = p_project_id and status not in ('void','reversed') and deleted_at is null
  loop
    perform public.acct_exec_void_txn(actor, t.id, coalesce(p_reason,'Project reset'), p_approval);
    n := n + 1;
  end loop;
  update public.acct_refund_settlements set status = 'cancelled'
   where project_id = p_project_id and status in ('draft','pending_approval','approved');
  update public.acct_projects
     set archived_at = case when p_delete then now() else archived_at end,
         archive_reason = case when p_delete then p_reason else archive_reason end,
         status = case when p_delete then 'Deleted' else 'Active' end
   where id = p_project_id;

  perform public.acct_log(actor, p_project_id, 'project', p_project_id,
    case when p_delete then 'Project Deleted (archived)' else 'Project Reset (archived)' end,
    p_reason, p_approval, null, null,
    format('%s transactions voided; complete financial snapshot archived and restorable', n));
  return jsonb_build_object('ok', true, 'voided', n);
end;
$$;

create or replace function public.acct_exec_restore_version(actor jsonb, p_archive_id uuid, p_approval uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  arch record;
  row_j jsonb;
  n int := 0;
begin
  select * into arch from public.acct_archives where id = p_archive_id;
  if arch.id is null then raise exception 'ACCT_RESTORE: archive not found'; end if;

  -- Reinstate each archived transaction's prior status. Rows are never
  -- physically deleted, so restoring is a status walk-back, fully audited.
  for row_j in select * from jsonb_array_elements(coalesce(arch.snapshot->'transactions','[]'::jsonb))
  loop
    update public.acct_transactions
       set status = row_j->>'status',
           void_reason = nullif(row_j->>'void_reason',''),
           deleted_at = null
     where id = (row_j->>'id')::uuid
       and status in ('void','reversed')
       and (row_j->>'status') not in ('void','reversed');
    if found then n := n + 1; end if;
  end loop;
  for row_j in select * from jsonb_array_elements(coalesce(arch.snapshot->'fee_ledger','[]'::jsonb))
  loop
    update public.acct_fee_ledger
       set status = row_j->>'status', provisional = coalesce((row_j->>'provisional')::boolean, provisional)
     where id = (row_j->>'id')::uuid
       and status in ('void','reversed')
       and (row_j->>'status') not in ('void','reversed');
  end loop;
  if arch.project_id is not null then
    update public.acct_projects set archived_at = null, archive_reason = null,
           status = coalesce(arch.snapshot->'project'->>'status','Active')
     where id = arch.project_id;
  end if;

  perform public.acct_log(actor, arch.project_id, 'archive', arch.id::text, 'Project Version Restored', null, p_approval,
    null, null, format('%s transactions reinstated from archive "%s"; audit history preserved end-to-end', n, arch.name));
  return jsonb_build_object('ok', true, 'restored', n);
end;
$$;

-- ------------------------------------------------------------
-- Steps 6–10: the Platform Super Admin decides. Self-approval is
-- refused. Approved actions execute inside this one database
-- transaction; the result is recorded and audited.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Sample accounting data: seeded automatically for an EMPTY
-- organization, behaves exactly like real records, is marked
-- is_sample, and is never seeded again once removed.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Legacy blob import: preserves every existing accounting record from
-- the app_state JSON store into the relational ledger. Records keep
-- their displayed values through a clearly-identified Legacy Migrated
-- Rate; ambiguous records go to the review queue instead of being
-- counted twice. Idempotent via legacy_id.
-- ------------------------------------------------------------
create or replace function public.acct_import_legacy(actor jsonb, blob jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  legacy_rate numeric := greatest(coalesce((blob->'settings'->>'rate')::numeric, 1310), 1);
  p jsonb; r jsonb;
  pid text;
  imported int := 0; flagged int := 0; skipped int := 0;
  kind text;
  coll text;
  amt numeric; cur text; st text;
  a_iqd numeric; a_usd numeric;
  new_no text;
  new_txn_id uuid;
  fee_rate numeric;
  fee_amt numeric;
  dup int;
begin
  perform public.acct_check_actor(actor, 'write');
  if blob is null then return jsonb_build_object('ok', false, 'error', 'empty backup'); end if;

  for p in select * from jsonb_array_elements(coalesce(blob->'projects','[]'::jsonb))
  loop
    pid := coalesce(p->>'id', 'prj_legacy_' || md5(p::text));
    if exists (select 1 from public.acct_projects where id = pid or legacy_id = pid) then
      skipped := skipped + 1; continue;
    end if;
    insert into public.acct_projects
      (id, code, name, client, region, type, status, currency, contract_value,
       fee_inherit, fee_method, fee_rate, fee_basis, fee_treatment, legacy_id, created_by)
    values
      (pid, p->>'code', coalesce(p->>'name','(legacy project)'), p->>'client',
       coalesce(p->>'region','Iraq'), coalesce(p->>'type','Construction'), coalesce(p->>'status','Active'),
       case when upper(coalesce(p->>'currency','')) = 'USD' then 'USD' else 'IQD' end,
       nullif(p->>'contractValue','')::numeric,
       false, 'percentage', coalesce(nullif(p->>'consultancyRate','')::numeric, 0), 'funding', 'deduct_from_funding',
       pid, 'legacy-import');
    imported := imported + 1;
  end loop;

  for coll, kind in
    select * from (values ('funding','funding'), ('materials','material'), ('projectLabor','labor'),
                          ('expenses','expense'), ('revenue','revenue')) as m(c,k)
  loop
    for r in select * from jsonb_array_elements(coalesce(blob->coll,'[]'::jsonb))
    loop
      if r->>'id' is not null and exists (select 1 from public.acct_transactions where legacy_id = r->>'id') then
        skipped := skipped + 1; continue;
      end if;
      pid := r->>'projectId';
      amt := coalesce(nullif(r->>'amount','')::numeric, nullif(r->>'total','')::numeric);
      cur := case when upper(coalesce(r->>'currency','')) = 'USD' then 'USD' else 'IQD' end;
      -- Ambiguous: missing amount or unknown project → review queue, never guessed.
      if amt is null or amt <= 0 or pid is null or not exists (select 1 from public.acct_projects where id = pid) then
        insert into public.acct_review_queue (project_id, source, record_type, record_ref, note, payload, created_by)
        values (pid, 'legacy_import', kind, r->>'id',
                'Legacy record could not be imported automatically (missing amount or project)', r, 'legacy-import');
        flagged := flagged + 1; continue;
      end if;
      -- Ambiguous: an expense that duplicates an already-imported material/labor
      -- cost (same project, amount, date) → review queue instead of double-count.
      if kind = 'expense' then
        select count(*) into dup from public.acct_transactions x
         where x.project_id = pid and x.kind in ('material','labor')
           and x.original_amount = round(amt,2) and x.txn_date = coalesce(nullif(r->>'date','')::date, current_date);
        if dup > 0 then
          insert into public.acct_review_queue (project_id, source, record_type, record_ref, note, payload, created_by)
          values (pid, 'legacy_import', kind, r->>'id',
                  'Possible double-count: a material/labor record with the same project, amount, and date already exists', r, 'legacy-import');
          flagged := flagged + 1; continue;
        end if;
      end if;

      st := lower(coalesce(r->>'status','draft'));
      st := case
        when st in ('received') then 'received'
        when st in ('paid') then 'paid'
        when st in ('approved') then case when kind = 'funding' then 'posted' else 'approved' end
        when st in ('draft') then 'draft'
        when st in ('rejected') then 'rejected'
        when st in ('void') then 'void'
        else 'pending' end;
      if cur = 'IQD' then a_iqd := round(amt,2); a_usd := round(amt / legacy_rate, 2);
      else a_usd := round(amt,2); a_iqd := round(amt * legacy_rate, 2); end if;
      new_no := 'LRS-TXN-' || lpad(nextval('public.acct_txn_no_seq')::text, 6, '0');

      insert into public.acct_transactions
        (txn_no, project_id, kind, category, description, supplier, quantity, unit, txn_date, status,
         payment_source, original_amount, original_currency, exchange_rate, rate_source, rate_note,
         amount_iqd, amount_usd, legacy_id, legacy_collection, created_by_email, created_by_role, meta)
      values
        (new_no, pid, kind, r->>'category',
         coalesce(r->>'description', r->>'notes', r->>'item'), r->>'supplier',
         nullif(r->>'qty','')::numeric, r->>'unit',
         coalesce(nullif(r->>'date','')::date, current_date), st,
         r->>'paymentSource', round(amt,2), cur, legacy_rate, 'legacy_migrated',
         'Legacy Migrated Rate (displayed value preserved at import-time rate ' || legacy_rate || ')',
         a_iqd, a_usd, r->>'id', coll, 'legacy-import', 'Accountant', jsonb_build_object('legacy', true))
      returning id into new_txn_id;
      imported := imported + 1;

      -- Preserve the legacy funding consultancy fee EXACTLY as recorded —
      -- historical entries are never recalculated to the new 8% default.
      if kind = 'funding' then
        fee_rate := coalesce(nullif(r->>'consultancyRate','')::numeric, 0);
        fee_amt := coalesce(nullif(r->>'consultancyFee','')::numeric, round(amt * fee_rate, 2));
        if coalesce((r->>'waived')::boolean, false) then fee_amt := 0; end if;
        if fee_amt > 0 and st in ('received','posted','paid') then
          insert into public.acct_fee_ledger
            (project_id, source_txn_id, entry_type, calc_method, fee_rate, calc_basis, basis_amount,
             fee_amount, currency, exchange_rate, fee_iqd, fee_usd, treatment, config_source, status,
             provisional, note, created_by)
          values
            (pid, new_txn_id, 'fee', 'percentage', fee_rate, 'funding', round(amt,2), round(fee_amt,2), cur,
             legacy_rate,
             case when cur='IQD' then round(fee_amt,2) else round(fee_amt*legacy_rate,2) end,
             case when cur='USD' then round(fee_amt,2) else round(fee_amt/legacy_rate,2) end,
             'deduct_from_funding', 'legacy', 'posted', true,
             'Imported from legacy record ' || coalesce(r->>'id','?'), 'legacy-import');
        end if;
      end if;
    end loop;
  end loop;

  perform public.acct_log(actor, null, 'import', null, 'Legacy Accounting Data Imported', null, null, null, null,
    format('%s records imported, %s sent to review, %s already present (skipped). Legacy Migrated Rate %s used where no historical rate existed.',
      imported, flagged, skipped, legacy_rate));
  return jsonb_build_object('ok', true, 'imported', imported, 'review', flagged, 'skipped', skipped);
end;
$$;

-- ------------------------------------------------------------
-- One-call bootstrap for the accounting engine.
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

-- Paged audit history (append-only; read-only from the client).
create or replace function public.acct_get_audit(p_project_id text default null, p_before bigint default null, p_limit int default 200)
returns jsonb
language sql
security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb)
    from (select * from public.acct_audit
           where (p_project_id is null or project_id = p_project_id)
             and (p_before is null or id < p_before)
           order by id desc
           limit least(greatest(coalesce(p_limit,200),1),1000)) x;
$$;

do $$
begin
  revoke all on function public.acct_request_protected(jsonb,text,text,text,jsonb,text) from public, anon;
  grant execute on function public.acct_request_protected(jsonb,text,text,text,jsonb,text) to authenticated;
  revoke all on function public.acct_decide_approval(jsonb,text,uuid,boolean,text) from public, anon;
  grant execute on function public.acct_decide_approval(jsonb,text,uuid,boolean,text) to authenticated;
  revoke all on function public.acct_seed_sample_data(jsonb) from public, anon;
  grant execute on function public.acct_seed_sample_data(jsonb) to authenticated;
  revoke all on function public.acct_import_legacy(jsonb,jsonb) from public, anon;
  grant execute on function public.acct_import_legacy(jsonb,jsonb) to authenticated;
  revoke all on function public.acct_get_bootstrap(int) from public, anon;
  grant execute on function public.acct_get_bootstrap(int) to authenticated;
  revoke all on function public.acct_get_audit(text,bigint,int) from public, anon;
  grant execute on function public.acct_get_audit(text,bigint,int) to authenticated;
  revoke all on function public.acct_exec_void_txn(jsonb,uuid,text,uuid) from public, anon, authenticated;
  revoke all on function public.acct_exec_remove_sample(jsonb,uuid) from public, anon, authenticated;
  revoke all on function public.acct_exec_project_reset(jsonb,text,text,uuid,boolean) from public, anon, authenticated;
  revoke all on function public.acct_exec_restore_version(jsonb,uuid,uuid) from public, anon, authenticated;
end;
$$;
