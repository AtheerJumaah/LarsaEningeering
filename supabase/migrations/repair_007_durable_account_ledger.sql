/* The durable account ledger.
 *
 * Attendance already had this protection and it worked: when a stale device
 * overwrote the shared staff blob, the punches walked back out of
 * attendance_events on the next open. Accounts had no such backstop — they
 * lived ONLY inside that one overwritable JSON document — so an account
 * created on one device could be erased by another device saving an older
 * copy of the same document, with nothing left to restore it from.
 *
 * This table is that backstop. Every account that has ever appeared in the
 * blob is recorded here, whole, and nothing can delete a row: the trigger
 * below refuses DELETE for every role including the service role. An account
 * leaves circulation only by being TOMBSTONED, which is a deliberate,
 * attributed act, and even then the row and its history stay.
 *
 * The failure direction is chosen on purpose: if the tombstone itself were
 * ever lost, a removed account comes back and an administrator removes it
 * again. A real person's account never silently disappears. */

create table if not exists public.staff_accounts (
  uid               text primary key,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  name              text,
  normalized_email  text,
  access            text,
  username          text,
  -- The last complete account record, so a restore is faithful rather than a
  -- name-and-email stub: permissions, department, schedule links and all.
  record            jsonb not null default '{}'::jsonb,
  -- Set only by staff_account_tombstone(). Never by a client write.
  removed_at        timestamptz,
  removed_by        text,
  removed_reason    text
);

create index if not exists staff_accounts_email_idx on public.staff_accounts (normalized_email);
create index if not exists staff_accounts_live_idx  on public.staff_accounts (removed_at) where removed_at is null;

/* Nothing deletes an account row. Not the app, not an admin, not the service
   role. This is the same guarantee attendance_events carries. */
create or replace function public.staff_accounts_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'staff_accounts is append-only: accounts are tombstoned, never deleted';
end;
$$;

drop trigger if exists staff_accounts_block_delete on public.staff_accounts;
create trigger staff_accounts_block_delete
  before delete on public.staff_accounts
  for each row execute function public.staff_accounts_no_delete();

/* Removal or resurrection of the tombstone can only happen through these two
   functions, so a forged client payload cannot erase anybody. */
create or replace function public.staff_accounts_protect_tombstone()
returns trigger language plpgsql as $$
begin
  if current_setting('larsa.tombstone_ok', true) is distinct from 'yes' then
    new.removed_at     := old.removed_at;
    new.removed_by     := old.removed_by;
    new.removed_reason := old.removed_reason;
  end if;
  -- first_seen_at is history; it never moves once written.
  new.first_seen_at := old.first_seen_at;
  return new;
end;
$$;

drop trigger if exists staff_accounts_guard_tombstone on public.staff_accounts;
create trigger staff_accounts_guard_tombstone
  before update on public.staff_accounts
  for each row execute function public.staff_accounts_protect_tombstone();

alter table public.staff_accounts enable row level security;

drop policy if exists staff_accounts_read on public.staff_accounts;
create policy staff_accounts_read on public.staff_accounts
  for select using (true);

/* No direct INSERT or UPDATE policy: every write goes through the RPC below,
   which is the only way the descriptive columns can change at all. */

drop function if exists public.staff_account_upsert(jsonb);
create function public.staff_account_upsert(p_accounts jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  written integer := 0;
begin
  insert into public.staff_accounts as sa
    (uid, name, normalized_email, access, username, record, last_seen_at)
  select
    a->>'uid',
    nullif(a->>'name', ''),
    nullif(lower(trim(a->>'normalized_email')), ''),
    nullif(a->>'access', ''),
    nullif(a->>'username', ''),
    coalesce(a->'record', '{}'::jsonb),
    now()
  from jsonb_array_elements(p_accounts) a
  where coalesce(a->>'uid', '') <> ''
  on conflict (uid) do update set
    -- Never overwrite a known value with a blank one: a partial write from a
    -- half-loaded client must not hollow out a good record.
    name             = coalesce(nullif(excluded.name, ''), sa.name),
    normalized_email = coalesce(nullif(excluded.normalized_email, ''), sa.normalized_email),
    access           = coalesce(nullif(excluded.access, ''), sa.access),
    username         = coalesce(nullif(excluded.username, ''), sa.username),
    record           = case when excluded.record = '{}'::jsonb then sa.record else excluded.record end,
    last_seen_at     = now();
  get diagnostics written = row_count;
  return written;
end;
$$;

revoke all on function public.staff_account_upsert(jsonb) from public;
grant execute on function public.staff_account_upsert(jsonb) to anon, authenticated, service_role;

/* A deliberate, attributed removal. Called by the permanent-delete path only:
   offboarding and the recycling bin leave the account in place with a flag,
   so they are not removals at all as far as this ledger is concerned. */
drop function if exists public.staff_account_tombstone(text, text, text);
create function public.staff_account_tombstone(p_uid text, p_by text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('larsa.tombstone_ok', 'yes', true);
  update public.staff_accounts
     set removed_at = now(), removed_by = p_by, removed_reason = p_reason
   where uid = p_uid;
  perform set_config('larsa.tombstone_ok', 'no', true);
  return found;
end;
$$;

revoke all on function public.staff_account_tombstone(text, text, text) from public;
grant execute on function public.staff_account_tombstone(text, text, text) to anon, authenticated, service_role;

drop function if exists public.staff_account_untombstone(text, text);
create function public.staff_account_untombstone(p_uid text, p_by text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('larsa.tombstone_ok', 'yes', true);
  update public.staff_accounts
     set removed_at = null, removed_by = null,
         removed_reason = 'restored by ' || coalesce(p_by, 'unknown')
   where uid = p_uid;
  perform set_config('larsa.tombstone_ok', 'no', true);
  return found;
end;
$$;

revoke all on function public.staff_account_untombstone(text, text) from public;
grant execute on function public.staff_account_untombstone(text, text) to anon, authenticated, service_role;

grant select on public.staff_accounts to anon, authenticated, service_role;
