begin;
set local role authenticated;
do $$
declare
  r record;
  first_at timestamptz;
  first_id text := 'test-attendance-in-1';
  second_id text := 'test-attendance-out-1';
  replay_id text := 'test-attendance-out-replay';
begin
  select * into r from public.record_attendance_punch(
    first_id, '2099-10-08T09:00:00Z', 'employee-1', 'employee@example.com',
    'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_status <> 'In' or r.event_id <> first_id then
    raise exception 'first punch was not recorded correctly: %', row_to_json(r);
  end if;
  first_at := r.current_at;
  if first_at > clock_timestamp() + interval '1 minute' then
    raise exception 'device time was trusted over database time: %', first_at;
  end if;

  -- Retrying the exact same client event returns the stored event and does
  -- not insert a second row, even if the retry proposes a later timestamp.
  select * into r from public.record_attendance_punch(
    first_id, '2099-10-08T09:00:08Z', 'employee-1', 'employee@example.com',
    'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_at <> first_at then
    raise exception 'same event retry was not idempotent: %', row_to_json(r);
  end if;

  -- A different event targeting the already-current state is acknowledged
  -- as already satisfied and points to the existing canonical row.
  select * into r from public.record_attendance_punch(
    'test-attendance-in-duplicate', '2026-10-08T09:01:00Z', 'employee-1',
    'employee@example.com', 'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'already' or r.event_id <> first_id then
    raise exception 'same-state click created another event: %', row_to_json(r);
  end if;

  select * into r from public.record_attendance_punch(
    second_id, '2026-10-08T17:00:00Z', 'employee-1', 'employee@example.com',
    'Employee', 'Out', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_status <> 'Out' or r.event_id <> second_id then
    raise exception 'clock-out was not recorded: %', row_to_json(r);
  end if;

  select * into r from public.record_attendance_punch(
    replay_id, '2026-10-08T17:01:00Z', 'employee-1', 'employee@example.com',
    'Employee', 'Out', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'already' or r.event_id <> second_id then
    raise exception 'same-state clock-out created another event: %', row_to_json(r);
  end if;

  -- Tombstoned rows do not own the current state after a manager removes one.
  select * into r from public.record_attendance_punch(
    'test-attendance-out-after-reset', '2026-10-08T17:02:00Z', 'employee-1',
    'employee@example.com', 'Employee', 'Out', 'Office', null, null, 'live',
    array[second_id]::text[]
  );
  if r.outcome <> 'recorded' or r.event_id <> 'test-attendance-out-after-reset' then
    raise exception 'removed punch still blocked the clock: %', row_to_json(r);
  end if;

  if (select count(*) from public.attendance_events where uid = 'employee-1') <> 3 then
    raise exception 'expected exactly three canonical events';
  end if;
end $$;
rollback;
