#!/usr/bin/env bash
# Runs the accounting SQL test suite against a throwaway local PostgreSQL.
# Needs postgresql-16+ server binaries (initdb/pg_ctl) and psql on PATH or
# under /usr/lib/postgresql/*/bin. Everything runs inside one transaction
# and rolls back; the temporary cluster is deleted afterwards.
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
create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  -- Supabase's service role, which the push sender runs as.
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
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
create schema if not exists realtime;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language plpgsql as $shim$ begin return; end $shim$;
-- push_subscriptions predates these migrations; the notify migration ALTERs it.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(), staff_uid text not null,
  endpoint text not null unique, p256dh text not null, auth text not null,
  created_at timestamptz not null default now());
EOF

for f in $(ls "$repo"/supabase/migrations/2026*_acct_*.sql "$repo"/supabase/migrations/2026*_notify_*.sql 2>/dev/null | sort); do
  echo "applying $(basename "$f")"
  PGOPTIONS='-c client_min_messages=warning' psql -d acct_test -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done

total=0
for tf in "$here/accounting-sql.test.sql" "$here/accounting-review-sql.test.sql" \
          "$here/accounting-makerchecker-sql.test.sql" "$here/accounting-financials-sql.test.sql" \
          "$here/accounting-payroll-sql.test.sql" "$here/notifications-sql.test.sql" \
          "$here/qa-spec-sql.test.sql"; do
  out="$(psql -d acct_test -f "$tf" 2>&1)" || { echo "$out" | tail -20; exit 1; }
  echo "$out" | grep -E "FAIL|ERROR" && exit 1
  n="$(echo "$out" | grep -c "PASS:")"
  total=$((total + n))
done
echo "$total SQL checks passed"
echo "OK"
