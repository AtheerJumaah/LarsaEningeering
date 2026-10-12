begin;
do $$
declare r record; t timestamptz:=clock_timestamp();
begin
  perform public.record_attendance_action('diag-correct-in',t-interval '3 hours','diag-corrected-uid',null,'Rollback','In');
  perform public.record_attendance_action('diag-correct-out',t-interval '2 hours','diag-corrected-uid',null,'Rollback','Out');
  update public.app_state set data=jsonb_set(data,'{logs}',coalesce(data->'logs','[]'::jsonb)||jsonb_build_array(
    jsonb_build_object('id','diag-correct-out','uid','diag-corrected-uid','status','Out','time',t-interval '150 minutes','touchedAt',t)))
  where store_key='larsaStaffV8';
  select * into r from public.record_attendance_action('diag-correct-next-in',t-interval '135 minutes','diag-corrected-uid',null,'Rollback','In');
  if r.outcome<>'recorded' then raise exception 'Approved effective trim not respected'; end if;
end $$;
rollback;
