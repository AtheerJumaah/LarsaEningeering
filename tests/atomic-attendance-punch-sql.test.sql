begin;
set local role authenticated;
do $$
declare
  r record;
  first_at timestamptz;
  base_at timestamptz := clock_timestamp() - interval '12 hours';
  first_id text := 'test-attendance-in-1';
  second_id text := 'test-attendance-out-1';
  replay_id text := 'test-attendance-out-replay';
begin
  select * into r from public.record_attendance_punch(
    first_id, base_at, 'employee-1', 'employee@example.com',
    'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_status <> 'In' or r.event_id <> first_id then
    raise exception 'first punch was not recorded correctly: %', row_to_json(r);
  end if;
  first_at := r.current_at;
  if abs(extract(epoch from (first_at - base_at))) > 0.001 then
    raise exception 'captured punch time was not preserved: expected %, got %', base_at, first_at;
  end if;

  -- Retrying the exact same client event returns the stored event and does
  -- not insert a second row, even if the retry proposes a later timestamp.
  select * into r from public.record_attendance_punch(
    first_id, base_at + interval '8 seconds', 'employee-1', 'employee@example.com',
    'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_at <> first_at then
    raise exception 'same event retry was not idempotent: %', row_to_json(r);
  end if;

  -- A different event targeting the already-current state is acknowledged
  -- as already satisfied and points to the existing canonical row.
  select * into r from public.record_attendance_punch(
    'test-attendance-in-duplicate', base_at + interval '1 minute', 'employee-1',
    'employee@example.com', 'Employee', 'In', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'already' or r.event_id <> first_id then
    raise exception 'same-state click created another event: %', row_to_json(r);
  end if;

  select * into r from public.record_attendance_punch(
    second_id, base_at + interval '8 hours', 'employee-1', 'employee@example.com',
    'Employee', 'Out', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'recorded' or r.current_status <> 'Out' or r.event_id <> second_id then
    raise exception 'clock-out was not recorded: %', row_to_json(r);
  end if;
  if r.current_at <> base_at + interval '8 hours' then
    raise exception 'offline clock-out time was not preserved: %', r.current_at;
  end if;

  select * into r from public.record_attendance_punch(
    replay_id, base_at + interval '8 hours 1 minute', 'employee-1', 'employee@example.com',
    'Employee', 'Out', 'Office', null, null, 'live', '{}'::text[]
  );
  if r.outcome <> 'already' or r.event_id <> second_id then
    raise exception 'same-state clock-out created another event: %', row_to_json(r);
  end if;

  -- Tombstoned rows do not own the current state after a manager removes one.
  select * into r from public.record_attendance_punch(
    'test-attendance-out-after-reset', base_at + interval '8 hours 2 minutes', 'employee-1',
    'employee@example.com', 'Employee', 'Out', 'Office', null, null, 'live',
    array[second_id]::text[]
  );
  if r.outcome <> 'recorded' or r.event_id <> 'test-attendance-out-after-reset' then
    raise exception 'removed punch still blocked the clock: %', row_to_json(r);
  end if;

  if (select count(*) from public.attendance_events where uid = 'employee-1') <> 3 then
    raise exception 'expected exactly three canonical events';
  end if;

  -- A severely future-dated event is rejected for review, never silently
  -- stamped at reconnect time or inserted into the attendance ledger.
  begin
    perform * from public.record_attendance_punch(
      'test-attendance-future-rejected', clock_timestamp() + interval '1 day',
      'employee-2', 'employee2@example.com', 'Employee 2', 'In', 'Office',
      null, null, 'live', '{}'::text[]
    );
    raise exception 'future punch should have been rejected';
  exception when sqlstate '22023' then
    if sqlerrm not like 'Attendance punch time needs review:%' then raise; end if;
  end;
  if exists (select 1 from public.attendance_events where uid = 'employee-2') then
    raise exception 'rejected future punch was inserted';
  end if;
end $$;
rollback;
