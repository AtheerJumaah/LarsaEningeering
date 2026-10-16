-- Attendance latency hardening.
--
-- Employee punches are committed to attendance_events.  Cross-device
-- readers poll by inserted_at, while the punch RPC reads one employee's
-- chronology.  Keep both access paths indexed as the ledger grows.
create index if not exists attendance_events_inserted_at_idx
  on public.attendance_events (inserted_at asc);

-- Updating a non-attendance field in the staff document must not expand every
-- historical log just to refresh the correction overlay.  Punches no longer
-- write this document, but this guard also protects profile/theme/admin saves.
create or replace function public.refresh_attendance_corrections()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.store_key <> 'larsaStaffV8' then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and (old.data->'logs') is not distinct from (new.data->'logs') then
    return new;
  end if;

  begin
    with current_logs as materialized (
      select distinct on (x.value->>'id')
        x.value->>'id' as client_event_id,
        case
          when pg_input_is_valid(x.value->>'time', 'timestamptz')
          then (x.value->>'time')::timestamptz
          else null
        end as effective_occurred_at,
        x.ordinality
      from jsonb_array_elements(
        coalesce(new.data->'logs', '[]'::jsonb)
      ) with ordinality as x(value, ordinality)
      where nullif(x.value->>'id', '') is not null
      order by x.value->>'id', x.ordinality desc
    ),
    corrections as materialized (
      select l.client_event_id, l.effective_occurred_at
      from current_logs l
      join public.attendance_events e using (client_event_id)
      where l.effective_occurred_at is not null
        and l.effective_occurred_at is distinct from e.occurred_at
    ),
    upserted as (
      insert into public.attendance_corrections (
        client_event_id, effective_occurred_at
      )
      select client_event_id, effective_occurred_at
      from corrections
      on conflict (client_event_id) do update
      set effective_occurred_at = excluded.effective_occurred_at,
          corrected_at = clock_timestamp()
      returning client_event_id
    )
    delete from public.attendance_corrections c
    where not exists (
      select 1 from corrections x
      where x.client_event_id = c.client_event_id
    );
  exception when others then
    raise warning 'refresh_attendance_corrections failed open: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.refresh_attendance_corrections() from public, anon, authenticated;
drop trigger if exists attendance_corrections_refresh on public.app_state;
create trigger attendance_corrections_refresh
after insert or update of data on public.app_state
for each row execute function public.refresh_attendance_corrections();
