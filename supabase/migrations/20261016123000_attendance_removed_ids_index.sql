-- Attendance punch latency repair: do not parse the large legacy staff blob
-- while holding the per-employee punch lock just to find removed log ids.
-- The ledger remains append-only and the staff document remains the source
-- for administrative edits; this is a derived lookup table only.

create table if not exists public.attendance_removed_events (
  client_event_id text primary key,
  removed_at timestamptz not null default clock_timestamp()
);

alter table public.attendance_removed_events enable row level security;
revoke all on public.attendance_removed_events from public;
grant select on public.attendance_removed_events to anon, authenticated;
drop policy if exists attendance_removed_events_select on public.attendance_removed_events;
create policy attendance_removed_events_select
  on public.attendance_removed_events
  for select to anon, authenticated using (true);

-- Preserve every existing tombstone before switching the RPC to the index.
insert into public.attendance_removed_events (client_event_id)
select distinct x.value
from public.app_state s
cross join lateral jsonb_array_elements_text(
  coalesce(s.data->'removedLogIds', '[]'::jsonb)
) as x(value)
where s.store_key = 'larsaStaffV8'
  and nullif(x.value, '') is not null
on conflict (client_event_id) do nothing;

-- Keep the derived table current only when the tombstone list changes. This
-- trigger is fail-open: a malformed legacy document never blocks an employee
-- punch; the next valid staff-document save repairs the index.
create or replace function public.refresh_attendance_removed_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.store_key <> 'larsaStaffV8'
    or (tg_op = 'UPDATE' and old.data->'removedLogIds' is not distinct from new.data->'removedLogIds') then
    return new;
  end if;

  begin
    with current_ids as materialized (
      select distinct nullif(x.value, '') as client_event_id
      from jsonb_array_elements_text(
        coalesce(new.data->'removedLogIds', '[]'::jsonb)
      ) as x(value)
      where nullif(x.value, '') is not null
    )
    insert into public.attendance_removed_events (client_event_id)
    select client_event_id from current_ids
    on conflict (client_event_id) do nothing;

    delete from public.attendance_removed_events r
    where not exists (
      select 1 from current_ids x
      where x.client_event_id = r.client_event_id
    );
  exception when others then
    raise warning 'refresh_attendance_removed_events failed open: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.refresh_attendance_removed_events() from public, anon, authenticated;
drop trigger if exists attendance_removed_events_refresh on public.app_state;
create trigger attendance_removed_events_refresh
after insert or update of data on public.app_state
for each row execute function public.refresh_attendance_removed_events();

-- Replace only the tombstone lookup; transition ordering, idempotency, audit
-- fields, and correction semantics remain unchanged.
do $body$
declare definition text; patched text;
begin
  select pg_get_functiondef(
    'public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb)'::regprocedure
  ) into definition;
  if position('attendance_removed_events' in definition) > 0 then
    return;
  end if;
  if position('select coalesce(array_agg(value), ''{}'') into v_removed' in definition) = 0 then
    raise exception 'Unexpected attendance RPC; refusing tombstone lookup patch';
  end if;
  patched := replace(
    definition,
    $old$select coalesce(array_agg(value), '{}') into v_removed
    from public.app_state s,
      lateral jsonb_array_elements_text(coalesce(s.data->'removedLogIds','[]'::jsonb)) x(value)
    where s.store_key='larsaStaffV8';$old$,
    $new$select coalesce(array_agg(r.client_event_id), '{}') into v_removed
    from public.attendance_removed_events r;$new$
  );
  if patched = definition then
    raise exception 'Attendance RPC tombstone lookup was not replaced';
  end if;
  execute patched;
end;
$body$;

revoke all on function public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb) from public;
grant execute on function public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb) to anon, authenticated;
