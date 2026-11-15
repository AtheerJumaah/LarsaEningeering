#!/usr/bin/env bash
# Runs the accounting and attendance SQL suites against a throwaway PostgreSQL.
# Needs postgresql-16+ server binaries (initdb/pg_ctl) and psql on PATH or
# under /usr/lib/postgresql/*/bin. Test fixtures roll back in each suite.
# The temporary cluster is deleted afterwards.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
PATH="${bin:+$bin:}$PATH"

work="$(mktemp -d)"
trap 'pg_ctl -D "$work/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

initdb -D "$work/data" -U postgres -A trust >/dev/null
pg_ctl -D "$work/data" -o "-k $work -p 5544 -c listen_addresses=''" -l "$work/pg.log" start >/dev/null
export PGHOST="$work" PGPORT=5544 PGUSER=postgres
createdb acct_test

# Shims for the Supabase-managed pieces the migrations reference.
psql -d acct_test -v ON_ERROR_STOP=1 -q <<'EOF'
create schema if not exists auth;
create or replace function auth.role() returns text language sql as $$ select 'authenticated'::text $$;
-- Real Supabase's auth.uid() reads the signed-in user id out of the request
-- JWT. Locally there is no JWT, so this reads a session GUC instead — unset
-- (the default for every pre-existing test) it is null, exactly the old
-- hardcoded behavior; a test that needs to act as a specific auth.users row
-- (e.g. a Viewer) sets request.jwt.claim.sub or request.jwt.claims before
-- the statements it wants evaluated as that user.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  -- Supabase's service role, which the push sender runs as.
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema auth to anon, authenticated, service_role;
-- Minimal auth.users shim: just enough shape (id, email) for viewer_accounts'
-- FK and for tests to seed a "signed-in Viewer" row. Real Supabase's table
-- has many more columns; nothing here reads them.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
create table if not exists public.platform_admins (email text primary key, added_by text, added_at timestamptz default now());
create table if not exists public.auth_codes (
  id uuid primary key default gen_random_uuid(), email text, purpose text check (purpose in ('verify','reset')),
  code text, attempts int default 0, consumed_at timestamptz, created_at timestamptz default now(), expires_at timestamptz);
-- The notification trigger broadcasts a content-free "look again" ping through
-- Supabase Realtime. Locally there is no Realtime, and the trigger already
-- swallows its own failure, but a shim keeps the log free of noise that would
-- hide a real error.
-- Vault, as the dispatch migration reads it. Locally it is a plain table —
-- the point is the SHAPE (secrets in, decrypted_secrets out), not the crypto.
create schema if not exists vault;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create or replace function vault.create_secret(new_secret text, new_name text, new_description text default '')
returns uuid language plpgsql as $shim$
declare sid uuid;
begin
  insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description)
  on conflict (name) do update set secret = excluded.secret returning id into sid;
  return sid;
end $shim$;
create or replace view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret, description from vault.secrets;
create schema if not exists extensions;
-- pg_net shim: the real extension is a Supabase-managed async HTTP worker
-- and does not exist on a vanilla local PostgreSQL. The dispatch trigger
-- only ever fires-and-forgets net.http_post, so a no-op with the same
-- signature keeps every code path testable.
create schema if not exists net;
create or replace function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language plpgsql as $shim$ begin return 1; end $shim$;
-- pg_cron shim, same reasoning: scheduling is Supabase-managed; the
-- migrations only register jobs.
create schema if not exists cron;
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql as $shim$ begin return 1; end $shim$;
create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $shim$ begin return true; end $shim$;
create schema if not exists realtime;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language plpgsql as $shim$ begin return; end $shim$;
-- push_subscriptions predates these migrations; the notify migration ALTERs it.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(), staff_uid text not null,
  endpoint text not null unique, p256dh text not null, auth text not null,
  created_at timestamptz not null default now());
-- app_state (see supabase/schema.sql) predates the acct_* migrations and is
-- owned by the main app's sync layer, not this accounting subsystem — it is
-- shimmed here only because the viewer-accounts migration adds a "viewer
-- blocked" policy to it. Shape and the pre-existing permissive policy match
-- schema.sql exactly.
create table if not exists public.app_state (
  store_key   text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
-- A real Supabase project grants table privileges to anon/authenticated by
-- default at the project level (outside any migration file); nothing here
-- replicates that for tables the acct_* migrations don't themselves touch,
-- so app_state needs it spelled out, or RLS is never even reached and every
-- query just fails on the base grant instead.
grant select, insert, update, delete on public.app_state to anon, authenticated;
alter table public.app_state enable row level security;
do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'app_state' and policyname = 'authenticated read/write') then
    create policy "authenticated read/write" on public.app_state
      for all
      using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;
end $$;
EOF

while IFS= read -r f; do
  echo "applying $(basename "$f")"
  # `create extension pg_net` cannot run on a vanilla local server; the shim
  # above provides net.http_post instead, so the line is dropped here only.
  sed -E 's/^create extension if not exists pg_(net|cron).*$//' "$f" \
    | PGOPTIONS='-c client_min_messages=warning' psql -d acct_test -v ON_ERROR_STOP=1 -q >/dev/null
done < <(printf '%s\n' "$repo"/supabase/migrations/2026*_acct_*.sql \
  "$repo"/supabase/migrations/2026*_notify_*.sql "$repo"/supabase/migrations/2026*_audit_*.sql \
  "$repo"/supabase/migrations/2026*_sync_*.sql | sort)

apply_repair() {
  local migration="$repo/supabase/migrations/$1.sql"
  echo "applying $(basename "$migration")"
  PGOPTIONS='-c client_min_messages=warning' psql -d acct_test -v ON_ERROR_STOP=1 -q -f "$migration" >/dev/null
}

# The incident-repair migrations that shape schema/behaviour, in production
# order. repair_001 (a point-in-time backup), repair_003 (alters live
# verification tables not shimmed here) and repair_004/005 (one-time data
# recovery against real production rows) are deliberately not replayed.
for name in repair_002_durable_attendance_ledger_and_write_hardening \
            repair_002b_ledger_break_statuses \
            repair_006_pin_trigger_search_path \
            repair_007_durable_account_ledger \
            repair_008_server_guard_stale_writes \
            repair_009_attendance_ledger_anon_access \
            repair_012_atomic_attendance_punch; do
  apply_repair "$name"
done

total=0
suites=0
run_sql_test() {
  local tf="$1" out n
  if ! out="$(psql -d acct_test -v ON_ERROR_STOP=1 -f "$tf" 2>&1)"; then
    printf '%s\n' "$out" | tail -20
    return 1
  fi
  if grep -E 'FAIL|ERROR' <<< "$out"; then return 1; fi
  n="$(grep -c 'PASS:' <<< "$out" || true)"
  total=$((total + n))
  suites=$((suites + 1))
  echo "passed $(basename "$tf")"
}

# These suites exercise the original attendance RPC and other legacy behavior.
for tf in "$here/accounting-sql.test.sql" "$here/accounting-review-sql.test.sql" \
          "$here/accounting-makerchecker-sql.test.sql" "$here/accounting-financials-sql.test.sql" \
          "$here/accounting-payroll-sql.test.sql" "$here/accounting-admin-role-sql.test.sql" \
          "$here/notifications-sql.test.sql" "$here/app-state-cas-sql.test.sql" \
          "$here/viewer-accounts-sql.test.sql" "$here/notify-email-sql.test.sql" \
          "$here/qa-spec-sql.test.sql" "$here/repair-guard-sql.test.sql" \
          "$here/atomic-attendance-punch-sql.test.sql"; do
  run_sql_test "$tf"
done

psql -d acct_test -v ON_ERROR_STOP=1 -q -c 'create publication supabase_realtime'
for name in repair_014_attendance_chronology_audit \
            repair_015_attendance_writer_audit \
            repair_016_attendance_effective_corrections \
            repair_017_attendance_same_intent_race \
            repair_018_attendance_effective_query_cost \
            repair_019_shared_state_noop \
            repair_020_retire_legacy_attendance_writer \
            repair_021_attendance_realtime \
            repair_022_attendance_single_snapshot \
            repair_023_attendance_correction_index \
            repair_024_attendance_preserve_same_state_retry; do
  apply_repair "$name"
done

# The correction tests update the staff document, as the app does.
psql -d acct_test -v ON_ERROR_STOP=1 -q <<'EOF'
insert into public.app_state (store_key, data)
  values ('larsaStaffV8', '{"logs":[],"users":[]}'::jsonb)
  on conflict (store_key) do nothing;
EOF

for tf in "$here/attendance-correction-index.test.sql" \
          "$here/attendance-effective-correction.test.sql" \
          "$here/attendance-preserved-time.test.sql" \
          "$here/attendance-production-transaction.test.sql" \
          "$here/attendance-shared-state-noop.test.sql"; do
  run_sql_test "$tf"
done

echo "$suites SQL suites passed ($total named checks)"
echo "OK"
