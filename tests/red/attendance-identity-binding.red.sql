-- EXPECTED RED SQL CONTRACT PLAN — do not run against production.
--
-- This file is intentionally not included by tests/run-sql-tests.sh. It is a
-- read-only schema contract that should be executed only against an isolated
-- database after an approved shadow migration. Current production is expected
-- to fail the first assertions because the mapping table and server helpers do
-- not exist. It contains no fixture inserts or production writes.
--
-- Synthetic fixture identities (not SQL data):
--   staff: fixture-staff-self-001, fixture-staff-disabled-001,
--          fixture-staff-manager-001, fixture-staff-other-team-001
--   auth:  00000000-0000-4000-8000-000000000001 .. 000000000005

do $$
begin
  if to_regclass('public.staff_auth_identity') is null then
    raise exception '[RED GATE B-DB-001] public.staff_auth_identity is missing';
  end if;
end $$;

do $$
declare
  rel record;
begin
  select c.relrowsecurity, c.relforcerowsecurity
    into rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'staff_auth_identity';
  if not coalesce(rel.relrowsecurity, false) then
    raise exception '[RED GATE B-DB-002] mapping table must enable RLS';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'current_staff_uid'
  ) then
    raise exception '[RED GATE B-DB-003] current_staff_uid() helper is missing';
  end if;
end $$;

do $$
declare
  body text;
begin
  select pg_get_functiondef(p.oid)
    into body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_attendance_action'
   order by p.oid desc
   limit 1;
  if body is null or body !~ 'auth\.uid\(\)' then
    raise exception '[RED GATE B-DB-004] attendance writer must derive identity from auth.uid()';
  end if;
  if body ~ 'uid\s*=\s*p_uid' and body !~ 'p_uid.*consistency' then
    raise exception '[RED GATE B-DB-005] client p_uid remains an authority path';
  end if;
end $$;

-- The following are read-only privilege/policy checks. They are intentionally
-- assertions for the later enforcement gate, not Gate B mutations.
do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = 'attendance_events'
       and privilege_type = 'INSERT'
       and grantee in ('anon','authenticated')
  ) then
    raise exception '[RED GATE E-DB-001] direct attendance INSERT grant still exists';
  end if;
end $$;

