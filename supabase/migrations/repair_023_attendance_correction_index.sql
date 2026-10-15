-- Attendance punch latency repair: index the small effective-correction set.
--
-- attendance_events is the immutable punch ledger.  Approved attendance
-- corrections currently live in the large larsaStaffV8 JSON document, so the
-- punch RPC had to expand that document while holding the employee lock.  The
-- derived table below keeps the same effective-time semantics without moving,
-- rewriting, or deleting any historical ledger rows.

create table if not exists public.attendance_corrections (
  client_event_id text primary key,
  effective_occurred_at timestamptz not null,
  corrected_at timestamptz not null default clock_timestamp()
);

create index if not exists attendance_corrections_effective_idx
  on public.attendance_corrections (effective_occurred_at desc);

alter table public.attendance_corrections enable row level security;
revoke all on public.attendance_corrections from public;
grant select on public.attendance_corrections to anon, authenticated;
drop policy if exists attendance_corrections_select on public.attendance_corrections;
create policy attendance_corrections_select
  on public.attendance_corrections
  for select to anon, authenticated using (true);

-- Backfill only actual changes from the authoritative staff document.  Logs
-- whose time still equals the immutable event are intentionally omitted.
with current_logs as materialized (
  select distinct on (x.value->>'id')
    x.value->>'id' as client_event_id,
    case
      when pg_input_is_valid(x.value->>'time', 'timestamptz')
      then (x.value->>'time')::timestamptz
      else null
    end as effective_occurred_at,
    x.ordinality
  from public.app_state s
  cross join lateral jsonb_array_elements(
    coalesce(s.data->'logs', '[]'::jsonb)
  ) with ordinality as x(value, ordinality)
  where s.store_key = 'larsaStaffV8'
    and nullif(x.value->>'id', '') is not null
  order by x.value->>'id', x.ordinality desc
)
insert into public.attendance_corrections (client_event_id, effective_occurred_at)
select l.client_event_id, l.effective_occurred_at
from current_logs l
join public.attendance_events e using (client_event_id)
where l.effective_occurred_at is not null
  and l.effective_occurred_at is distinct from e.occurred_at
on conflict (client_event_id) do update
set effective_occurred_at = excluded.effective_occurred_at,
    corrected_at = clock_timestamp();

-- Keep the derived index synchronized for future correction writes.  This is
-- deliberately fail-open: an index refresh must never block a punch or make
-- an otherwise valid staff-document write fail.  The next staff update repairs
-- the index if a transient issue occurs.
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

-- The RPC now performs an indexed primary-key lookup for corrections instead
-- of expanding the complete staff JSON document under the employee lock.
create or replace function public.attendance_effective_events(p_uid text)
returns setof public.attendance_events
language sql
stable security invoker
set search_path = pg_catalog, public
as $$
  select (
    jsonb_populate_record(
      e,
      case
        when c.effective_occurred_at is not null
        then jsonb_build_object('occurred_at', c.effective_occurred_at)
        else '{}'::jsonb
      end
    )
  ).*
  from public.attendance_events e
  left join public.attendance_corrections c
    on c.client_event_id = e.client_event_id
  where e.uid = p_uid;
$$;

revoke all on function public.attendance_effective_events(text) from public;
grant execute on function public.attendance_effective_events(text) to anon, authenticated;
