-- Server receipt metadata applies to EVERY insert, including older clients and
-- historical correction imports. Actor employee ID is declared by the app;
-- auth_session_id identifies the actual Supabase session, not proof of staff login.
create or replace function public.attendance_capture_writer()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  new.inserted_at := clock_timestamp();
  new.auth_session_id := auth.uid();
  if new.actor_employee_id is null then
    if nullif(new.clocked_by,'') is not null then
      select u->>'id' into new.actor_employee_id
      from public.app_state s, lateral jsonb_array_elements(coalesce(s.data->'users','[]'::jsonb)) u
      where s.store_key='larsaStaffV8' and (u->>'id'=new.clocked_by or u->>'name'=new.clocked_by) limit 1;
    else
      new.actor_employee_id := new.uid;
    end if;
  end if;
  new.source := coalesce(nullif(new.source,''),'legacy-unclassified');
  return new;
end $$;
create trigger attendance_events_capture_writer before insert on public.attendance_events
for each row execute function public.attendance_capture_writer();
