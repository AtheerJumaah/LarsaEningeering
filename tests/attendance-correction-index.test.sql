begin;

do $$
declare
  r record;
  t timestamptz := clock_timestamp();
  corrected timestamptz := t - interval '150 minutes';
begin
  perform public.record_attendance_action(
    'diag-index-in', t - interval '3 hours', 'diag-index-uid', null,
    'Correction index test', 'In'
  );
  perform public.record_attendance_action(
    'diag-index-out', t - interval '2 hours', 'diag-index-uid', null,
    'Correction index test', 'Out'
  );

  update public.app_state
     set data = jsonb_set(
       data, '{logs}', coalesce(data->'logs', '[]'::jsonb) ||
         jsonb_build_array(jsonb_build_object(
           'id', 'diag-index-out', 'uid', 'diag-index-uid',
           'status', 'Out', 'time', corrected, 'touchedAt', t
         ))
   where store_key = 'larsaStaffV8';

  if not exists (
    select 1 from public.attendance_corrections
    where client_event_id = 'diag-index-out'
      and effective_occurred_at = corrected
  ) then
    raise exception 'Correction index was not refreshed';
  end if;

  select * into r
  from public.attendance_effective_events('diag-index-uid')
  where client_event_id = 'diag-index-out';
  if r.occurred_at is distinct from corrected then
    raise exception 'Effective correction time was not applied';
  end if;

  select * into r from public.record_attendance_action(
    'diag-index-next-in', t - interval '135 minutes', 'diag-index-uid',
    null, 'Correction index test', 'In'
  );
  if r.outcome <> 'recorded' then
    raise exception 'Corrected chronology rejected the next punch';
  end if;

  update public.app_state
     set data = jsonb_set(
       data, '{logs}', (
         select coalesce(jsonb_agg(item) filter (where item->>'id' <> 'diag-index-out'), '[]'::jsonb)
         from jsonb_array_elements(coalesce(data->'logs', '[]'::jsonb)) item
       )
   where store_key = 'larsaStaffV8';
  if exists (select 1 from public.attendance_corrections where client_event_id = 'diag-index-out') then
    raise exception 'Removed correction was not cleared from the index';
  end if;

  perform public.record_attendance_action(
    'diag-index-malformed', t, 'diag-index-uid', null,
    'Correction index test', 'Out'
  );
end $$;

rollback;
