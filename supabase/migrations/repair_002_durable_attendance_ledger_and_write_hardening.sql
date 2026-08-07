-- LARSA incident repair, step 1 of the permanent fix.
--
-- (A) attendance_events: an APPEND-ONLY ledger of every clock punch. The
--     shared staff blob remains the app's working state, but every punch is
--     also written here at punch time, and the app restores from here at
--     boot. A blob overwrite, an account deletion, an auth change, or a
--     stale device can therefore never again erase attendance history.
--     No role can UPDATE or DELETE rows -- enforced by trigger, not policy.
--
-- (B) app_state write path: the ONLY way to write the shared blobs becomes
--     the compare-and-swap RPC. Direct INSERT/UPDATE/DELETE grants are
--     revoked, which permanently disarms old cached app versions that still
--     carry the last-write-wins code that caused the Aug 6-7 losses: their
--     writes now fail instead of silently reverting everyone's data.

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  client_event_id text not null unique,
  occurred_at timestamptz not null,
  uid text not null,
  normalized_email text,
  person_name text,
  status text not null check (status in ('In','Out')),
  work_mode text,
  note text,
  clocked_by text,
  source text not null default 'live',
  inserted_at timestamptz not null default now()
);
create index if not exists attendance_events_occurred_idx on public.attendance_events (occurred_at desc);
create index if not exists attendance_events_uid_idx on public.attendance_events (uid, occurred_at);

alter table public.attendance_events enable row level security;
drop policy if exists attendance_events_insert on public.attendance_events;
create policy attendance_events_insert on public.attendance_events
  for insert to authenticated with check (auth.role() = 'authenticated');
drop policy if exists attendance_events_select on public.attendance_events;
create policy attendance_events_select on public.attendance_events
  for select to authenticated using (auth.role() = 'authenticated');

revoke all on public.attendance_events from anon;
grant select, insert on public.attendance_events to authenticated;
revoke update, delete, truncate on public.attendance_events from authenticated;

create or replace function public.attendance_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'attendance_events is append-only: % is not permitted', tg_op;
end $$;
drop trigger if exists attendance_events_no_update on public.attendance_events;
create trigger attendance_events_no_update
  before update or delete on public.attendance_events
  for each row execute function public.attendance_events_append_only();

-- Rebuild the CAS RPC as SECURITY DEFINER (drop first: the original had a
-- parameter default that create-or-replace cannot alter) and stamp
-- updated_by honestly.
drop function if exists public.app_state_put(text, jsonb, timestamptz);
create function public.app_state_put(
  p_store_key text,
  p_data jsonb,
  p_base_updated_at timestamptz default null
) returns table (applied boolean, current_data jsonb, current_updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  cur public.app_state%rowtype;
begin
  select a.* into cur from public.app_state a where a.store_key = p_store_key for update;
  if not found then
    begin
      return query
        insert into public.app_state (store_key, data, updated_by)
        values (p_store_key, coalesce(p_data, '{}'::jsonb), 'app_state_put')
        returning true, app_state.data, app_state.updated_at;
      return;
    exception when unique_violation then
      select a.* into cur from public.app_state a where a.store_key = p_store_key for update;
      if not found then raise; end if;
    end;
  end if;
  if p_base_updated_at is null or cur.updated_at is distinct from p_base_updated_at then
    return query select false, cur.data, cur.updated_at;
    return;
  end if;
  return query
    update public.app_state a
       set data = coalesce(p_data, '{}'::jsonb),
           updated_by = 'app_state_put'
     where a.store_key = p_store_key
    returning true, a.data, a.updated_at;
end $$;

revoke all on function public.app_state_put(text, jsonb, timestamptz) from public, anon;
grant execute on function public.app_state_put(text, jsonb, timestamptz) to authenticated;

-- The hard lock: no client role may write app_state directly any more. Old
-- cached bundles that still run last-write-wins upserts now fail loudly
-- instead of silently reverting the whole company's data.
revoke insert, update, delete, truncate on public.app_state from anon, authenticated;
revoke all on public.app_state from anon;
grant select on public.app_state to authenticated;
