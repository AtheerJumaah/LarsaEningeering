-- ============================================================
-- Larsa Control — Sync hardening 1: server-authoritative app_state writes
--
-- Why this exists. The whole company shares four JSON documents in
-- app_state (the staff directory + clock logs live in "larsaStaffV8"), and
-- every browser rewrites the WHOLE document through lib/supabase/sync.ts.
-- That layer already three-way-merges concurrent edits, but three holes
-- remained, and together they are how staff accounts kept vanishing and
-- people "could not log in again":
--
--   1. The write was select-then-upsert: two devices saving in the same
--      moment (every 8am clock-in rush) could both read the same base and
--      the second upsert silently flattened the first one's work. The
--      platform_backups history shows the smoking gun: the staff blob's
--      append-only clock log SHRANK between the 2026-08-05 and 2026-08-06
--      snapshots (80 → 78 rows, 6 → 5 users), which only a whole-document
--      revert can do.
--   2. updated_at was stamped by the CLIENT's clock. One phone with a
--      fast clock published a stamp from the future, after which that
--      device could never again detect that the shared row had moved on —
--      so it stopped merging and clobbered on every save. (Wrong phone
--      clocks are also why recorded attendance times were wrong — fixed
--      client-side with server_now() below.)
--   3. A device whose bootstrap pull failed half-way had no "last seen"
--      stamp at all, and the old code treated that as "nothing to check
--      against" and pushed its stale local copy straight over the top.
--
-- The fix moves the authority into the database, where a race cannot be
-- talked around:
--
--   * app_state_server_stamp trigger — updated_at is ALWAYS set by the
--     server (clock_timestamp()), whatever any client sends. Client clocks
--     stop participating in conflict detection entirely. clock_timestamp()
--     rather than now() so two writes inside one transaction (and the SQL
--     test harness, which wraps everything in one) still get distinct,
--     advancing stamps; the CAS below compares by equality, so the
--     theoretical backwards step of a host clock adjustment cannot
--     un-order anything that matters.
--   * app_state_put(key, data, base_updated_at) — compare-and-swap: the
--     write only lands if base_updated_at matches the row's current
--     updated_at exactly; otherwise NOTHING is written and the caller gets
--     (applied=false + the current row) back to merge against and retry.
--     A missing row is inserted; an EXISTING row with a NULL base is
--     refused — that is hole 3 dying: "I have no idea what the server
--     holds" can never again translate into "so overwrite it".
--     SECURITY INVOKER on purpose: RLS (including the viewer block) and
--     the two protective triggers already on app_state
--     (app_state_guard_super_admin_trg, protect_staff_secrets) keep
--     applying exactly as they do to a direct write. This function narrows
--     what a client can do; it must never widen it.
--   * server_now() — lets clients measure their clock skew and stamp
--     attendance punches with corrected time (see punchClock/punchBreak in
--     app/page.tsx and the Timeclock engine).
--
-- Old cached clients keep writing through the plain upsert path until
-- their service worker refreshes; the stamp trigger already fixes their
-- timestamps server-side, so they are no worse than before this migration,
-- and they age out on their next visit (network-first navigation + cache
-- bump). Additive only: no table or column changes, no row changes, no
-- existing function touched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Server-side stamping. Trigger name starts with "zz" so it runs after
--    the two existing BEFORE triggers on this table (PostgreSQL fires
--    same-event triggers alphabetically); they inspect and repair
--    new.data, this one only stamps new.updated_at, so any order would be
--    correct — the name just keeps the composition obvious.
-- ------------------------------------------------------------
create or replace function public.app_state_server_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists zz_app_state_server_stamp_trg on public.app_state;
create trigger zz_app_state_server_stamp_trg
  before insert or update on public.app_state
  for each row execute function public.app_state_server_stamp();

-- ------------------------------------------------------------
-- 2. The compare-and-swap write. Returned columns are prefixed current_*
--    so they cannot collide with app_state's own column names inside the
--    function body.
-- ------------------------------------------------------------
create or replace function public.app_state_put(
  p_store_key text,
  p_data jsonb,
  p_base_updated_at timestamptz default null
)
returns table (applied boolean, current_data jsonb, current_updated_at timestamptz)
language plpgsql
-- security invoker (the default) — deliberately NOT definer; see header.
set search_path = public, pg_temp
as $$
declare
  cur public.app_state%rowtype;
begin
  select a.* into cur from public.app_state a where a.store_key = p_store_key for update;
  if not found then
    begin
      return query
        insert into public.app_state (store_key, data)
        values (p_store_key, coalesce(p_data, '{}'::jsonb))
        returning true, app_state.data, app_state.updated_at;
      return;
    exception when unique_violation then
      -- Two devices raced to create the same row; the loser locks the
      -- winner's row and reports a conflict like any other stale base.
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
       set data = coalesce(p_data, '{}'::jsonb)
     where a.store_key = p_store_key
    returning true, a.data, a.updated_at;
end;
$$;

revoke all on function public.app_state_put(text, jsonb, timestamptz) from public;
grant execute on function public.app_state_put(text, jsonb, timestamptz) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. The server clock, for skew measurement. VOLATILE (the default) —
--    clock_timestamp() moves within a transaction and the function must
--    never be constant-folded.
-- ------------------------------------------------------------
create or replace function public.server_now()
returns timestamptz
language sql
set search_path = public, pg_temp
as $$ select clock_timestamp() $$;

revoke all on function public.server_now() from public;
grant execute on function public.server_now() to anon, authenticated, service_role;
