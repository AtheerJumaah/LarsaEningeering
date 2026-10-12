begin;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$
declare r record; uid text := 'diagnostic-rollback-only-no-staff'; t timestamptz := clock_timestamp();
begin
  select * into r from public.record_attendance_action('diag-in',t-interval '3 hours',uid,null,'Rollback test','In','Office',null,null,'test','{}',uid,'{"id":"rollback-device"}');
  if r.outcome <> 'recorded' or r.current_at <> t-interval '3 hours' then raise exception 'Original In time not preserved'; end if;
  select * into r from public.record_attendance_action('diag-out',t-interval '2 hours',uid,null,'Rollback test','Out');
  if r.outcome <> 'recorded' then raise exception 'Out failed'; end if;
  -- An older historical record arriving AFTER the Out must not own status.
  insert into public.attendance_events(client_event_id,occurred_at,uid,status,source) values('diag-late-history',t-interval '4 hours',uid,'In','legacy-import-test');
  select * into r from public.record_attendance_action('diag-duplicate-out',t-interval '150 minutes',uid,null,'Rollback test','Out');
  if r.outcome <> 'already' or r.event_id <> 'diag-out' then raise exception 'Upload ordering still overrides actual chronology'; end if;
  select * into r from public.record_attendance_action('diag-in',t,uid,null,'Rollback test','In');
  if r.event_id <> 'diag-in' or r.current_at <> t-interval '3 hours' then raise exception 'Uncertain replay not idempotent'; end if;
  select * into r from public.record_attendance_action('diag-in2',t-interval '1 hour',uid,null,'Rollback test','In');
  select * into r from public.record_attendance_action('diag-break',t-interval '50 minutes',uid,null,'Rollback test','Break Start');
  select * into r from public.record_attendance_action('diag-break-end',t-interval '40 minutes',uid,null,'Rollback test','Break End');
  select * into r from public.record_attendance_action('diag-out2',t-interval '30 minutes',uid,null,'Rollback test','Out');
  if r.current_status <> 'Out' then raise exception 'Break sequence altered punch direction'; end if;
  begin
    perform public.record_attendance_action('diag-future',t+interval '1 day',uid,null,'Rollback test','In');
    raise exception 'Future clock accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.record_attendance_action('diag-old',t-interval '5 hours',uid,null,'Rollback test','In');
    raise exception 'Out-of-sequence clock accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.record_attendance_action('diag-break-outside-shift',t,uid,null,'Rollback test','Break Start');
    raise exception 'Break outside shift accepted';
  exception when invalid_parameter_value then null; end;
  if (select count(*) from public.attendance_events e where e.uid='diagnostic-rollback-only-no-staff') <> 7 then raise exception 'Duplicate/invalid event inserted'; end if;
  if not exists(select 1 from public.attendance_events where client_event_id='diag-in' and actor_employee_id='diagnostic-rollback-only-no-staff' and auth_session_id='00000000-0000-4000-8000-000000000001' and device_info->>'id'='rollback-device') then raise exception 'Audit metadata missing'; end if;
end $$;
rollback;
