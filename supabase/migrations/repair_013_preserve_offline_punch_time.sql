-- Preserve the timestamp captured when an employee punched while offline.
-- inserted_at remains the server receipt time for ordering and audit. The
-- earlier RPC ignored p_occurred_at and stamped every queued punch with the
-- reconnect time, collapsing an offline In/Out pair into a near-zero shift.
-- Refuse timestamps that are too far ahead/behind or out of sequence instead
-- of silently inventing a time. The client retains refused events for review.
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
returns table(
  outcome text, current_status text, current_at timestamptz, event_id text,
  current_work_mode text, current_note text, current_clocked_by text
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current public.attendance_events%rowtype;
  v_existing public.attendance_events%rowtype;
  v_received_at timestamptz;
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
    return query select 'recorded'::text, v_existing.status, v_existing.occurred_at,
      v_existing.client_event_id, v_existing.work_mode, v_existing.note, v_existing.clocked_by;
    return;
  end if;

  v_received_at := clock_timestamp();
  if p_occurred_at > v_received_at + interval '2 minutes'
    or p_occurred_at < v_received_at - interval '36 hours' then
    raise exception using
      errcode = '22023',
      message = 'Attendance punch time needs review: outside the accepted clock window';
  end if;

  select e.* into v_current
  from public.attendance_events e
  where e.uid = p_uid
    and e.status in ('In', 'Out')
    and not (e.client_event_id = any(coalesce(p_removed_ids, '{}'::text[])))
  order by e.inserted_at desc, e.id desc
  limit 1;

  if found and v_current.status = p_status then
    return query select 'already'::text, v_current.status, v_current.occurred_at,
      v_current.client_event_id, v_current.work_mode, v_current.note, v_current.clocked_by;
    return;
  end if;

  if found and p_occurred_at <= v_current.occurred_at then
    raise exception using
      errcode = '22023',
      message = 'Attendance punch time needs review: earlier than the latest accepted punch';
  end if;

  -- A small positive device/server offset is clamped to receipt time. Offline
  -- times within the accepted window stay intact, including the real gap
  -- between clock-in and clock-out.
  v_occurred_at := greatest(
    least(p_occurred_at, v_received_at),
    coalesce(v_current.occurred_at + interval '1 microsecond', '-infinity'::timestamptz)
  );

  insert into public.attendance_events (
    client_event_id, occurred_at, uid, normalized_email, person_name,
    status, work_mode, note, clocked_by, source
  ) values (
    p_client_event_id, v_occurred_at, p_uid, p_normalized_email, p_person_name,
    p_status, p_work_mode, p_note, p_clocked_by, coalesce(p_source, 'live')
  );

  return query select 'recorded'::text, p_status, v_occurred_at, p_client_event_id,
    p_work_mode, p_note, p_clocked_by;
end;
$$;
