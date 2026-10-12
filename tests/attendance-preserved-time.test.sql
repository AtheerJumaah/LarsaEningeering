begin;
do $$
declare r record; stamp timestamptz := clock_timestamp() - interval '2 hours';
begin
  select * into r from public.record_attendance_punch(
    'diagnostic-preserved-time', stamp, 'diagnostic-no-staff-account', null, 'Rollback test',
    'In', 'Office', 'Rollback-only behavioral test', null, 'test', '{}');
  if abs(extract(epoch from r.current_at - stamp)) > 0.001 then
    raise exception 'FAIL: delayed punch time was replaced with upload time';
  end if;
end $$;
rollback;
