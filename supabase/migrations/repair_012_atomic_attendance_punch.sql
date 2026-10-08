-- Serialize each employee's state transition in Postgres. The client_event_id
-- makes an ambiguous network retry idempotent; the per-employee transaction
-- lock prevents two tabs/devices from accepting the same stale state.
create or replace function public.record_attendance_punch(
  p_client_event_id text,
  p_occurred_at timestamptz,
  p_uid text,
  p_normalized_email text,
  p_person_name text,
  p_status text,
  p_work_mode text default null,
  p_note text default null,
  p_clocked_by text default null,
  p_source text default 'live',
  p_removed_ids text[] default '{}'::text[]
)
returns table(outcome text, current_status text, current_at timestamptz, event_id text)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.attendance_events%rowtype;
  v_existing public.attendance_events%rowtype;
  v_occurred_at timestamptz;
begin
  if nullif(trim(p_client_event_id), '') is null
    or nullif(trim(p_uid), '') is null
    or p_occurred_at is null
    or p_status is null
    or p_status not in ('In', 'Out') then
    raise exception 'Invalid attendance punch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_uid, 0));

  select e.* into v_existing
  from public.attendance_events e
  where e.client_event_id = p_client_event_id;
  if found then
    if v_existing.uid <> p_uid or v_existing.status <> p_status then
      raise exception 'Attendance event id was reused with different data';
    end if;
    return query select 'recorded'::text, v_existing.status, v_existing.occurred_at, v_existing.client_event_id;
    return;
  end if;

  select e.* into v_current
  from public.attendance_events e
  where e.uid = p_uid
    and e.status in ('In', 'Out')
    and not (e.client_event_id = any(coalesce(p_removed_ids, '{}'::text[])))
  order by e.occurred_at desc, e.inserted_at desc, e.client_event_id desc
  limit 1;

  if found and v_current.status = p_status then
    return query select 'already'::text, v_current.status, v_current.occurred_at, v_current.client_event_id;
    return;
  end if;

  v_occurred_at := greatest(p_occurred_at, coalesce(v_current.occurred_at + interval '1 microsecond', p_occurred_at));

  insert into public.attendance_events (
    client_event_id, occurred_at, uid, normalized_email, person_name,
    status, work_mode, note, clocked_by, source
  ) values (
    p_client_event_id, v_occurred_at, p_uid, p_normalized_email, p_person_name,
    p_status, p_work_mode, p_note, p_clocked_by, coalesce(p_source, 'live')
  );

  return query select 'recorded'::text, p_status, v_occurred_at, p_client_event_id;
end;
$$;

revoke all on function public.record_attendance_punch(text, timestamptz, text, text, text, text, text, text, text, text, text[]) from public;
grant execute on function public.record_attendance_punch(text, timestamptz, text, text, text, text, text, text, text, text, text[]) to anon, authenticated;
