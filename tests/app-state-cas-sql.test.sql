-- ============================================================
-- Larsa Control — app_state server-time + compare-and-swap tests
-- (migration 20260806_sync_001_app_state_server_time.sql)
--
-- Rules under test:
--   * updated_at is ALWAYS stamped by the server: whatever timestamp a
--     client sends on insert or update is discarded by the zz_ trigger.
--     This is what removed client clocks from conflict detection — a
--     phone with a fast clock used to publish a stamp from the future and
--     then clobber everyone on every save.
--   * app_state_put only writes when the caller's base stamp matches the
--     row's current one exactly; otherwise it returns (applied=false +
--     the current row) and writes NOTHING — including when the caller has
--     no base at all (the failed-bootstrap case that used to license a
--     blind overwrite of the whole staff directory).
--   * The refusal response carries exactly what a retry needs: merging
--     against it and re-calling with the returned stamp must succeed.
-- ============================================================
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.chk(label text, ok boolean)
returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;

do $$
declare
  r record;
  t1 timestamptz;
  t2 timestamptz;
begin
  -- ----------------------------------------------------------
  -- 1. The stamp trigger: client-supplied timestamps are discarded.
  --    clock_timestamp() advances within a transaction, so freshness is
  --    assertable even inside this test's single wrapping transaction.
  -- ----------------------------------------------------------
  insert into public.app_state (store_key, data, updated_at)
  values ('zz_cas_test', '{"v":1}'::jsonb, '2000-01-01T00:00:00Z');
  select a.updated_at into t1 from public.app_state a where a.store_key = 'zz_cas_test';
  perform pg_temp.chk('insert: a client-sent updated_at is replaced by the server clock',
    t1 > now() - interval '1 minute' and t1 <= clock_timestamp());

  update public.app_state set data = '{"v":2}'::jsonb, updated_at = '2000-01-01T00:00:00Z'
   where store_key = 'zz_cas_test';
  select a.updated_at into t2 from public.app_state a where a.store_key = 'zz_cas_test';
  perform pg_temp.chk('update: a client-sent updated_at is replaced too, and the stamp advances',
    t2 > t1 and t2 > now() - interval '1 minute');

  -- ----------------------------------------------------------
  -- 2. app_state_put inserts a missing row (no base needed) and stamps it.
  -- ----------------------------------------------------------
  select * into r from public.app_state_put('zz_cas_put', '{"users":[{"id":"u1"}]}'::jsonb, null);
  perform pg_temp.chk('put: a missing row is created and reported applied',
    r.applied and r.current_data = '{"users":[{"id":"u1"}]}'::jsonb and r.current_updated_at is not null);
  t1 := r.current_updated_at;

  -- ----------------------------------------------------------
  -- 3. The anti-clobber core: an EXISTING row + a NULL base is refused,
  --    and nothing is written.
  -- ----------------------------------------------------------
  select * into r from public.app_state_put('zz_cas_put', '{"users":[]}'::jsonb, null);
  perform pg_temp.chk('put: null base against an existing row is refused (failed bootstrap can no longer clobber)',
    r.applied = false and r.current_data = '{"users":[{"id":"u1"}]}'::jsonb and r.current_updated_at = t1);
  perform pg_temp.chk('put: the refused write really wrote nothing',
    (select a.data from public.app_state a where a.store_key = 'zz_cas_put') = '{"users":[{"id":"u1"}]}'::jsonb);

  -- ----------------------------------------------------------
  -- 4. A stale base is refused the same way.
  -- ----------------------------------------------------------
  select * into r from public.app_state_put('zz_cas_put', '{"users":[]}'::jsonb, t1 - interval '1 second');
  perform pg_temp.chk('put: a stale base is refused and the current row is returned for the merge',
    r.applied = false and r.current_data = '{"users":[{"id":"u1"}]}'::jsonb and r.current_updated_at = t1);

  -- ----------------------------------------------------------
  -- 5. The matching base wins, and the refusal response is sufficient to
  --    retry from: use exactly what (4) returned.
  -- ----------------------------------------------------------
  select * into r from public.app_state_put('zz_cas_put', '{"users":[{"id":"u1"},{"id":"u2"}]}'::jsonb, t1);
  perform pg_temp.chk('put: the correct base applies the write and returns the fresh stamp',
    r.applied and r.current_data = '{"users":[{"id":"u1"},{"id":"u2"}]}'::jsonb and r.current_updated_at > t1);
  t2 := r.current_updated_at;
  perform pg_temp.chk('put: the applied write is what the table now holds',
    (select a.data from public.app_state a where a.store_key = 'zz_cas_put') = '{"users":[{"id":"u1"},{"id":"u2"}]}'::jsonb);

  -- ----------------------------------------------------------
  -- 6. The stamp the CAS compares against is the trigger's, end to end:
  --    an out-of-band write (an old cached client's raw upsert) moves the
  --    stamp, so a CAS holding the pre-upsert stamp must now be refused.
  -- ----------------------------------------------------------
  update public.app_state set data = '{"users":[{"id":"u1"}]}'::jsonb where store_key = 'zz_cas_put';
  select * into r from public.app_state_put('zz_cas_put', '{"users":[]}'::jsonb, t2);
  perform pg_temp.chk('put: a raw legacy write moves the stamp and stales every in-flight CAS, as it must',
    r.applied = false and r.current_data = '{"users":[{"id":"u1"}]}'::jsonb and r.current_updated_at > t2);

  -- ----------------------------------------------------------
  -- 7. server_now() exists for skew measurement and tells server time.
  -- ----------------------------------------------------------
  perform pg_temp.chk('server_now() returns the server clock',
    public.server_now() between now() - interval '1 minute' and clock_timestamp() + interval '1 second');

  raise notice 'ALL APP_STATE CAS SQL TESTS PASSED';
end $$;

select 'APP_STATE CAS SQL TESTS COMPLETE' as done;
rollback;
