create function public.latest_attendance_shift(p_uid text)
returns table (id text, status text, occurred_at timestamptz, work_mode text)
language sql stable security invoker
set search_path = ''
as $$
  select e.client_event_id, e.status, coalesce(c.effective_occurred_at, e.occurred_at), e.work_mode
  from public.attendance_events e
  left join public.attendance_corrections c using (client_event_id)
  where e.uid = p_uid and e.status in ('In', 'Out')
    and not exists (
      select 1 from public.attendance_removed_events r where r.client_event_id = e.client_event_id
    )
  order by coalesce(c.effective_occurred_at, e.occurred_at) desc, e.inserted_at desc, e.id desc
  limit 1
$$;

revoke all on function public.latest_attendance_shift(text) from public, anon;
grant execute on function public.latest_attendance_shift(text) to authenticated;
