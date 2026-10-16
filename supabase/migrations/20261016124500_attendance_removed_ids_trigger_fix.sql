-- The first tombstone-index migration intentionally failed open if a trigger
-- invocation tried to reuse a CTE across two SQL statements. Re-define the
-- trigger with one add-only INSERT; old tombstones are never resurrected.
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
  exception when others then
    raise warning 'refresh_attendance_removed_events failed open: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.refresh_attendance_removed_events() from public, anon, authenticated;
