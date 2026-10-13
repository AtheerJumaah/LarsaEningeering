/*
 * LARSA STAGING-ONLY ATTENDANCE IDENTITY CONTRACT
 *
 * This artifact is intentionally outside supabase/migrations. It may be
 * applied only to the blank synthetic staging project named in the runbook.
 * It must never be copied to production or used to enroll a real Auth user.
 * The rows below use reserved .test emails and UUIDs from
 * tests/fixtures/attendance-identity-fixtures.mjs.
 *
 * Contract:
 *   - staff_auth_identity is the only Auth -> staff binding.
 *   - enabled, non-offboarded mappings may write their own events.
 *   - manager mappings may write only enabled staff in manager_team_ids.
 *   - attendance_events has no direct client table grants and is append-only.
 *   - actor_employee_id, auth_session_id, display identity, and clocked_by are
 *     server-derived; client actor/display fields are audit input only.
 *   - client_event_id is an exactly-once idempotency key.
 *   - occurred_at is preserved and must not move backwards for a target.
 */

create extension if not exists pgcrypto;

create table if not exists public.staff_accounts (
  uid text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  name text,
  normalized_email text,
  access text,
  username text,
  team_id text,
  record jsonb not null default '{}'::jsonb,
  removed_at timestamptz,
  removed_by text,
  removed_reason text
);

create table if not exists public.staff_auth_identity (
  auth_user_id uuid primary key,
  staff_uid text not null unique references public.staff_accounts(uid),
  enabled boolean not null default true,
  role text not null default 'employee' check (role in ('employee', 'manager')),
  manager_team_ids text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists staff_auth_identity_staff_idx
  on public.staff_auth_identity(staff_uid);

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  client_event_id text not null unique,
  occurred_at timestamptz not null,
  uid text not null references public.staff_accounts(uid),
  normalized_email text,
  person_name text,
  status text not null check (status in ('In', 'Out', 'Break Start', 'Break End')),
  work_mode text,
  note text,
  clocked_by text,
  source text not null default 'employee-punch',
  inserted_at timestamptz not null default now(),
  actor_employee_id text not null,
  auth_session_id uuid not null,
  device_info jsonb
);

create index if not exists attendance_events_chronology_idx
  on public.attendance_events(uid, occurred_at desc, inserted_at desc, id desc);

/* No public table access: all reads/writes cross the server RPC boundary. */
alter table public.staff_accounts enable row level security;
alter table public.staff_accounts force row level security;
alter table public.staff_auth_identity enable row level security;
alter table public.staff_auth_identity force row level security;
alter table public.attendance_events enable row level security;
alter table public.attendance_events force row level security;
revoke all on table public.staff_accounts from public, anon, authenticated;
revoke all on table public.staff_auth_identity from public, anon, authenticated;
revoke all on table public.attendance_events from public, anon, authenticated;

create or replace function public.staff_auth_identity_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.staff_auth_identity_touch_updated_at() from public, anon, authenticated;
drop trigger if exists staff_auth_identity_touch_updated_at on public.staff_auth_identity;
create trigger staff_auth_identity_touch_updated_at
before update on public.staff_auth_identity
for each row execute function public.staff_auth_identity_touch_updated_at();

create or replace function public.attendance_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'attendance_events is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

revoke all on function public.attendance_events_append_only() from public, anon, authenticated;
drop trigger if exists attendance_events_no_update on public.attendance_events;
create trigger attendance_events_no_update
before update or delete on public.attendance_events
for each row execute function public.attendance_events_append_only();

/* Internal helper. It is deliberately not executable by client roles. */
create or replace function public.current_staff_uid()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select i.staff_uid
  from public.staff_auth_identity i
  join public.staff_accounts s on s.uid = i.staff_uid
  where i.auth_user_id = (select auth.uid())
    and i.enabled
    and s.removed_at is null
  limit 1
$$;

revoke all on function public.current_staff_uid() from public, anon, authenticated;

drop function if exists public.record_attendance_action(
  text, timestamptz, text, text, text, text, text, text, text, text, text[], text, jsonb
);

/*
 * Server-authoritative attendance operation. p_uid, p_actor_employee_id,
 * p_clocked_by, p_person_name, and p_normalized_email are never used as
 * identity authority. The Auth JWT and staff_auth_identity determine actor;
 * staff_accounts determines target display data.
 */
create function public.record_attendance_action(
  p_client_event_id text,
  p_occurred_at timestamptz,
  p_uid text,
  p_normalized_email text,
  p_person_name text,
  p_status text,
  p_work_mode text default null,
  p_note text default null,
  p_clocked_by text default null,
  p_source text default 'employee-punch',
  p_removed_ids text[] default '{}',
  p_actor_employee_id text default null,
  p_device_info jsonb default null
)
returns table(
  outcome text,
  current_status text,
  current_at timestamptz,
  event_id text,
  current_work_mode text,
  current_note text,
  current_clocked_by text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_auth_uid uuid := (select auth.uid());
  v_identity public.staff_auth_identity%rowtype;
  v_actor public.staff_accounts%rowtype;
  v_target public.staff_accounts%rowtype;
  v_current public.attendance_events%rowtype;
  v_shift public.attendance_events%rowtype;
  v_existing public.attendance_events%rowtype;
  v_target_uid text;
  v_now timestamptz := clock_timestamp();
begin
  if v_auth_uid is null then
    raise exception 'Attendance requires a verified Auth session' using errcode = '42501';
  end if;

  select i.* into v_identity
  from public.staff_auth_identity i
  join public.staff_accounts s on s.uid = i.staff_uid
  where i.auth_user_id = v_auth_uid
    and i.enabled
    and s.removed_at is null;
  if not found then
    raise exception 'Authenticated user has no enabled staff mapping' using errcode = '42501';
  end if;
  select s.* into v_actor from public.staff_accounts s where s.uid = v_identity.staff_uid;

  if nullif(trim(p_client_event_id), '') is null
     or p_occurred_at is null
     or p_status not in ('In', 'Out', 'Break Start', 'Break End') then
    raise exception 'Invalid attendance action' using errcode = '22023';
  end if;

  v_target_uid := nullif(trim(p_uid), '');
  if v_target_uid is null then
    v_target_uid := v_actor.uid;
  end if;
  select s.* into v_target from public.staff_accounts s where s.uid = v_target_uid;
  if not found then
    raise exception 'Attendance target does not exist' using errcode = '42501';
  end if;

  if v_target.uid <> v_actor.uid and not (
    v_identity.role = 'manager'
    and v_target.team_id is not null
    and v_target.team_id = any(v_identity.manager_team_ids)
    and v_target.removed_at is null
  ) then
    raise exception 'Attendance target is outside the authenticated staff scope'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_target.uid, 0));

  select e.* into v_existing
  from public.attendance_events e
  where e.client_event_id = p_client_event_id;
  if found then
    if v_existing.uid <> v_target.uid or v_existing.status <> p_status then
      raise exception 'Attendance event id reused with different action' using errcode = '22023';
    end if;
    return query select 'already'::text, v_existing.status, v_existing.occurred_at,
      v_existing.client_event_id, v_existing.work_mode, v_existing.note, v_existing.clocked_by;
    return;
  end if;

  select e.* into v_current
  from public.attendance_events e
  where e.uid = v_target.uid
  order by e.occurred_at desc, e.inserted_at desc, e.id desc
  limit 1;

  if p_occurred_at < v_now - interval '36 hours'
     or p_occurred_at > v_now + interval '2 minutes'
     or (v_current.id is not null and p_occurred_at < v_current.occurred_at) then
    raise exception 'Attendance punch time needs review' using errcode = '22023';
  end if;

  if v_current.status = p_status then
    return query select 'already'::text, v_current.status, v_current.occurred_at,
      v_current.client_event_id, v_current.work_mode, v_current.note, v_current.clocked_by;
    return;
  end if;

  select e.* into v_shift
  from public.attendance_events e
  where e.uid = v_target.uid and e.status in ('In', 'Out')
  order by e.occurred_at desc, e.inserted_at desc, e.id desc
  limit 1;
  if p_status = 'Break Start' and v_shift.status is distinct from 'In' then
    raise exception 'Attendance break requires an open shift; needs review' using errcode = '22023';
  end if;
  if p_status = 'Break End' and v_current.status is distinct from 'Break Start' then
    raise exception 'Attendance break end has no open break; needs review' using errcode = '22023';
  end if;

  insert into public.attendance_events(
    client_event_id, occurred_at, uid, normalized_email, person_name, status,
    work_mode, note, clocked_by, source, actor_employee_id, auth_session_id, device_info
  ) values (
    p_client_event_id, p_occurred_at, v_target.uid, v_target.normalized_email,
    v_target.name, p_status, p_work_mode, p_note,
    v_actor.uid, coalesce(nullif(trim(p_source), ''), 'employee-punch'),
    v_actor.uid, v_auth_uid, p_device_info
  );

  return query select 'recorded'::text, p_status, p_occurred_at,
    p_client_event_id, p_work_mode, p_note, v_actor.uid;
end;
$$;

revoke all on function public.record_attendance_action(
  text, timestamptz, text, text, text, text, text, text, text, text, text[], text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_attendance_action(
  text, timestamptz, text, text, text, text, text, text, text, text, text[], text, jsonb
) to authenticated;

/* Synthetic fixture rows only. No auth.users rows are inserted here. */
insert into public.staff_accounts
  (uid, name, normalized_email, access, username, team_id, record, removed_at)
values
  ('fixture-staff-self-001', 'Synthetic Self', 'self-001@example.test', 'employee', 'self-001', null, '{"synthetic":true}'::jsonb, null),
  ('fixture-staff-disabled-001', 'Synthetic Disabled', 'disabled-001@example.test', 'employee', 'disabled-001', null, '{"synthetic":true}'::jsonb, now()),
  ('fixture-staff-manager-001', 'Synthetic Manager', 'manager-001@example.test', 'manager', 'manager-001', null, '{"synthetic":true}'::jsonb, null),
  ('fixture-staff-team-alpha-001', 'Synthetic Team Alpha', 'team-alpha-001@example.test', 'employee', 'team-alpha-001', 'fixture-team-alpha', '{"synthetic":true}'::jsonb, null),
  ('fixture-staff-other-team-001', 'Synthetic Team Beta', 'other-team-001@example.test', 'employee', 'other-team-001', 'fixture-team-beta', '{"synthetic":true}'::jsonb, null),
  ('fixture-staff-blank-email-001', 'Synthetic Blank Email', null, 'employee', 'blank-email-001', null, '{"synthetic":true}'::jsonb, null)
on conflict (uid) do update set
  name = excluded.name,
  normalized_email = excluded.normalized_email,
  access = excluded.access,
  username = excluded.username,
  team_id = excluded.team_id,
  record = excluded.record,
  removed_at = excluded.removed_at;

insert into public.staff_auth_identity
  (auth_user_id, staff_uid, enabled, role, manager_team_ids)
values
  ('00000000-0000-4000-8000-000000000001', 'fixture-staff-self-001', true, 'employee', '{}'),
  ('00000000-0000-4000-8000-000000000002', 'fixture-staff-manager-001', true, 'manager', '{fixture-team-alpha}')
on conflict (auth_user_id) do update set
  staff_uid = excluded.staff_uid,
  enabled = excluded.enabled,
  role = excluded.role,
  manager_team_ids = excluded.manager_team_ids;

/* The collision fixture remains intentionally unmapped. The unique staff_uid
 * constraint is the database guard against two Auth UUIDs binding to one
 * staff record. */
