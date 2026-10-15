-- Attendance punch latency repair.
--
-- The immutable ledger is indexed, but record_attendance_action previously
-- called attendance_effective_events twice while holding the employee
-- advisory lock.  attendance_effective_events must inspect the legacy
-- app_state correction overlay, so the same 20k+ log document was expanded
-- twice for every punch.  Under concurrent punches/retries that work held the
-- per-employee lock long enough to create multi-second waits.  Materialize
-- one effective snapshot and derive both the current event and current shift
-- from it.  The state transition remains serialized and the correction
-- semantics are unchanged.
create or replace function public.record_attendance_action(
  p_client_event_id text, p_occurred_at timestamptz, p_uid text,
  p_normalized_email text, p_person_name text, p_status text,
  p_work_mode text default null, p_note text default null,
  p_clocked_by text default null, p_source text default 'employee-punch',
  p_removed_ids text[] default '{}', p_actor_employee_id text default null,
  p_device_info jsonb default null
)
returns table(outcome text, current_status text, current_at timestamptz, event_id text,
  current_work_mode text, current_note text, current_clocked_by text)
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_current public.attendance_events%rowtype;
  v_shift public.attendance_events%rowtype;
  v_existing public.attendance_events%rowtype;
  v_state record;
  v_received timestamptz := clock_timestamp();
  v_removed text[];
begin
  if nullif(trim(p_client_event_id),'') is null or nullif(trim(p_uid),'') is null
    or p_occurred_at is null or p_status is null
    or p_status not in ('In','Out','Break Start','Break End') then
    raise exception 'Invalid attendance action' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_uid, 0));

  -- Idempotency is checked after the lock as well as by the unique index: a
  -- timeout retry can arrive while the first request is still committing.
  select e.* into v_existing
    from public.attendance_events e
    where e.client_event_id = p_client_event_id;
  if found then
    if v_existing.uid <> p_uid or v_existing.status <> p_status then
      raise exception 'Attendance event id reused with different action' using errcode = '22023';
    end if;
    return query select 'recorded'::text, v_existing.status, v_existing.occurred_at,
      v_existing.client_event_id, v_existing.work_mode, v_existing.note, v_existing.clocked_by;
    return;
  end if;

  -- Tombstones come from the authoritative document as well as the caller.
  select coalesce(array_agg(value), '{}') into v_removed
    from public.app_state s,
      lateral jsonb_array_elements_text(coalesce(s.data->'removedLogIds','[]'::jsonb)) x(value)
    where s.store_key='larsaStaffV8';
  v_removed := v_removed || coalesce(p_removed_ids,'{}');

  -- Expand the effective correction overlay once.  Both chronology checks use
  -- the same snapshot, avoiding a second full JSON expansion while the
  -- employee lock is held.
  with effective as materialized (
    select e.*
      from public.attendance_effective_events(p_uid) e
      where not (e.client_event_id = any(v_removed))
  )
  select
    (select e from effective e
      where e.status in ('In','Out')
      order by e.occurred_at desc, e.inserted_at desc, e.id desc limit 1) as shift_event,
    (select e from effective e
      where case when p_status in ('In','Out') then e.status in ('In','Out')
        else e.status in ('In','Out','Break Start','Break End') end
      order by e.occurred_at desc, e.inserted_at desc, e.id desc limit 1) as current_event
  into v_state;
  v_shift := v_state.shift_event;
  v_current := v_state.current_event;

  -- An uncertain retry must never silently become a punch at reconnection.
  if p_occurred_at < v_received - interval '36 hours'
    or p_occurred_at > v_received + interval '2 minutes'
    or (v_current.id is not null and p_occurred_at < v_current.occurred_at) then
    raise exception 'Attendance punch time needs review' using errcode='22023';
  end if;
  if v_current.status=p_status then
    return query select 'already'::text, v_current.status, v_current.occurred_at,
      v_current.client_event_id, v_current.work_mode, v_current.note, v_current.clocked_by;
    return;
  end if;
  if p_status='Break Start' and (v_shift.status is distinct from 'In') then
    raise exception 'Attendance break requires an open shift; needs review' using errcode='22023';
  end if;
  if p_status='Break End' and (v_current.status is distinct from 'Break Start') then
    raise exception 'Attendance break end has no open break; needs review' using errcode='22023';
  end if;
  insert into public.attendance_events(client_event_id,occurred_at,uid,normalized_email,
    person_name,status,work_mode,note,clocked_by,source,actor_employee_id,auth_session_id,device_info)
    values(p_client_event_id,p_occurred_at,p_uid,p_normalized_email,p_person_name,p_status,
      p_work_mode,p_note,p_clocked_by,coalesce(p_source,'employee-punch'),
      p_actor_employee_id,auth.uid(),p_device_info);
  return query select 'recorded'::text,p_status,p_occurred_at,p_client_event_id,
    p_work_mode,p_note,p_clocked_by;
end $$;

revoke all on function public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb) from public;
grant execute on function public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb) to anon, authenticated;
