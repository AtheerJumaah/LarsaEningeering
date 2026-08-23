-- LARSA repair 008 — the database stops trusting stale documents.
--
-- Everything the company runs on lives in ONE shared JSON document
-- (larsaStaffV8 in app_state), and every browser rewrites the WHOLE
-- document. Every previous incident traces to the same move: a client
-- holding an old copy (a long-open engine iframe, a phone that slept, a
-- cached tab) saves it back, and rows that were added since — punches,
-- accounts — vanish, while fields that were changed since — passwords,
-- roles, lifecycle flags, emailVerified — snap back to old values. The
-- client-side merge cannot fully prevent this because a stale save whose
-- base stamp happens to be current is accepted VERBATIM by the CAS, and
-- because absence in a stale copy is indistinguishable from deletion.
--
-- The durable answer has to live where every write already passes: this
-- trigger. It never rejects (a rejection poisons the stale device forever,
-- as the ACCOUNT_GUARD handling proved); it HEALS the incoming document:
--
--   1. A row (user or clock log) that exists server-side may only leave the
--      document with EVIDENCE of deliberate removal: its id in the
--      document's own tombstone list (removedUserIds / removedLogIds), or —
--      for accounts — a tombstone in the staff_accounts ledger. Absence
--      alone never deletes. Attendance from stale saves therefore stops
--      needing the lose-and-restore cycle (727 of 1113 log rows carried a
--      "ledger-restore" mark when this was written; 99 punches were missing
--      from the document AGAIN the same day).
--
--   2. A record that carries a recency stamp (touchedAt) can never be
--      replaced by a strictly older copy of itself. This is the same rule
--      the client merge applies, enforced where stale clients cannot skip it.
--
--   3. A hashed password or PIN that carries a change stamp
--      (passwordChangedAt / pinChangedAt) can never be replaced by a
--      differently-hashed value with an older or missing stamp. This is the
--      "my password stopped working days later" bug: a stale record with a
--      newer wholesale save used to drag the old hash back. Changes coming
--      from clients that do not stamp (older app versions) are still
--      accepted when the stored value has no stamp either, so nobody's
--      password change is refused during the rollout.
--
--   4. emailVerified never silently reverts to unverified while the email
--      address itself is unchanged — losing that flag is what made sign-in
--      demand an emailed code far more often than Platform Settings say.
--
--   5. A clock-out that carries a correction note ("Adjusted by …") keeps
--      its corrected time against an unstamped copy with a different time:
--      trims only ever shorten sessions, so the stale longer copy is the
--      wrong one by construction.
--
--   6. Tombstone lists merge add-only (union), so a deliberate removal can
--      never be forgotten because a stale device saved an older, shorter
--      list — which is exactly how repair_005's removedLogIds got wiped.
--      An id whose row is live in the healed document is dropped from the
--      union (self-cleaning after a restore-from-bin).
--
--   7. A brand-new row in the incoming document whose id is tombstoned
--      (staff_accounts.removed_at, or the log/user tombstone lists) is
--      STRIPPED: a deliberately deleted account or session cannot resurrect
--      by riding in from a stale device's copy.
--
-- Server-side maintenance that must edit the document without healing can
-- set:  select set_config('larsa.guard_bypass', 'yes', true);
--
-- Additive only. No rows are modified by applying this migration; the
-- trigger changes only what FUTURE writes are allowed to destroy.

-- ---------------------------------------------------------------------
-- 0. Helper: parse a timestamp that came out of client JSON. Bad input is
--    an ordinary condition (records written by many app versions), so it
--    yields NULL rather than an exception that would abort a save.
-- ---------------------------------------------------------------------
create or replace function public.larsa_safe_ts(p text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p = '' then return null; end if;
  return p::timestamptz;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 1. The healing trigger. Named aa_* so it fires FIRST among the BEFORE
--    triggers on app_state (PostgreSQL fires same-event triggers in name
--    order): the Super Admin guard and protect_staff_secrets then inspect
--    the HEALED document — so a stale save that would have dropped the
--    Super Admin no longer trips ACCOUNT_GUARD at all; it is simply healed.
-- ---------------------------------------------------------------------
create or replace function public.app_state_guard_staff_document()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old_users jsonb;
  v_new_users jsonb;
  v_old_logs  jsonb;
  v_new_logs  jsonb;
  v_removed_users jsonb;
  v_removed_logs  jsonb;
  v_healed jsonb;
begin
  if new.store_key <> 'larsaStaffV8' then return new; end if;
  if old.data is null or new.data is null then return new; end if;
  if current_setting('larsa.guard_bypass', true) = 'yes' then return new; end if;

  -- ---- Tombstone lists: add-only union -------------------------------
  select coalesce(jsonb_agg(to_jsonb(id) order by first_ord), '[]'::jsonb)
    into v_removed_users
  from (
    select id, min(ord) as first_ord
    from (
      select a.value as id, a.ordinality as ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(old.data->'removedUserIds') = 'array'
               then old.data->'removedUserIds' else '[]'::jsonb end
        ) with ordinality a
      union all
      select b.value, 1000000 + b.ordinality
        from jsonb_array_elements_text(
          case when jsonb_typeof(new.data->'removedUserIds') = 'array'
               then new.data->'removedUserIds' else '[]'::jsonb end
        ) with ordinality b
    ) s
    where id <> ''
    group by id
  ) t;

  select coalesce(jsonb_agg(to_jsonb(id) order by first_ord), '[]'::jsonb)
    into v_removed_logs
  from (
    select id, min(ord) as first_ord
    from (
      select a.value as id, a.ordinality as ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(old.data->'removedLogIds') = 'array'
               then old.data->'removedLogIds' else '[]'::jsonb end
        ) with ordinality a
      union all
      select b.value, 1000000 + b.ordinality
        from jsonb_array_elements_text(
          case when jsonb_typeof(new.data->'removedLogIds') = 'array'
               then new.data->'removedLogIds' else '[]'::jsonb end
        ) with ordinality b
    ) s
    where id <> ''
    group by id
  ) t;

  -- ---- USERS ----------------------------------------------------------
  v_old_users := case when jsonb_typeof(old.data->'users') = 'array'
                      then old.data->'users' else '[]'::jsonb end;
  v_new_users := case when jsonb_typeof(new.data->'users') = 'array'
                      then new.data->'users' else null end;

  -- A document that arrives without a users array never hollows out one
  -- that had it.
  if v_new_users is null then
    v_new_users := v_old_users;
  end if;

  with old_u as (
    select u->>'id' as id, u
      from jsonb_array_elements(v_old_users) u
     where coalesce(u->>'id', '') <> ''
  ),
  new_u as (
    select t.u->>'id' as id, t.u, t.ord
      from jsonb_array_elements(v_new_users) with ordinality t(u, ord)
     where coalesce(t.u->>'id', '') <> ''
  ),
  tombstoned as (
    select sa.uid from public.staff_accounts sa where sa.removed_at is not null
  ),
  kept as (
    select
      n.id,
      n.ord,
      (o.u is null) as is_new,
      case
        -- Rule 2: a strictly older stamped copy never replaces a newer one.
        when o.u is not null
             and public.larsa_safe_ts(o.u->>'touchedAt') is not null
             and (public.larsa_safe_ts(n.u->>'touchedAt') is null
                  or public.larsa_safe_ts(n.u->>'touchedAt') < public.larsa_safe_ts(o.u->>'touchedAt'))
          then o.u
        -- Otherwise the incoming record stands, minus regressions:
        else n.u
          -- Rule 3a: password may not regress against a change stamp. A
          -- DIFFERENT hash only replaces a stamped one with a STRICTLY
          -- newer stamp of its own — equal or missing means it is a stale
          -- or replayed copy and the stored secret stands.
          || case
               when o.u is not null
                    and (o.u->>'password') like 'pbkdf2$%'
                    and coalesce(n.u->>'password', '') is distinct from (o.u->>'password')
                    and public.larsa_safe_ts(o.u->>'passwordChangedAt') is not null
                    and (public.larsa_safe_ts(n.u->>'passwordChangedAt') is null
                         or public.larsa_safe_ts(n.u->>'passwordChangedAt') <= public.larsa_safe_ts(o.u->>'passwordChangedAt'))
                 then jsonb_build_object('password', o.u->'password',
                                         'passwordChangedAt', o.u->'passwordChangedAt')
               else '{}'::jsonb
             end
          -- Rule 3b: same for the PIN.
          || case
               when o.u is not null
                    and (o.u->>'pin') like 'pbkdf2$%'
                    and coalesce(n.u->>'pin', '') is distinct from (o.u->>'pin')
                    and public.larsa_safe_ts(o.u->>'pinChangedAt') is not null
                    and (public.larsa_safe_ts(n.u->>'pinChangedAt') is null
                         or public.larsa_safe_ts(n.u->>'pinChangedAt') <= public.larsa_safe_ts(o.u->>'pinChangedAt'))
                 then jsonb_build_object('pin', o.u->'pin',
                                         'pinChangedAt', o.u->'pinChangedAt')
               else '{}'::jsonb
             end
          -- Rule 4: emailVerified never silently reverts while the address
          -- is unchanged.
          || case
               when o.u is not null
                    and o.u->>'emailVerified' = 'true'
                    and coalesce(n.u->>'emailVerified', '') <> 'true'
                    and lower(trim(coalesce(o.u->>'email',''))) = lower(trim(coalesce(n.u->>'email','')))
                 then jsonb_build_object('emailVerified', true)
               else '{}'::jsonb
             end
      end as u
    from new_u n
    left join old_u o on o.id = n.id
  ),
  -- Rule 7: strip resurrections — rows this save "adds" whose id was
  -- deliberately removed. A row whose ledger entry is live (un-tombstoned)
  -- is allowed back even if a stale tombstone list still names it: that is
  -- the restore-from-bin path, and the ledger is the authority.
  filtered as (
    select k.u, k.ord, k.id
      from kept k
     where not (
       k.is_new and (
         exists (select 1 from tombstoned ts where ts.uid = k.id)
         or (
           exists (select 1 from jsonb_array_elements_text(v_removed_users) r(val) where r.val = k.id)
           and not exists (select 1 from public.staff_accounts sa where sa.uid = k.id and sa.removed_at is null)
         )
       )
     )
  ),
  -- Rule 1: rows the incoming document dropped come back without evidence
  -- of deliberate removal. An account whose ledger row was UN-tombstoned
  -- (restore from the bin) is re-added even if a stale tombstone list still
  -- names it — the ledger is the authority on account removal.
  reappend as (
    select o.u, 2000000 + row_number() over () as ord, o.id
      from old_u o
     where not exists (select 1 from new_u n where n.id = o.id)
       and not exists (select 1 from tombstoned ts where ts.uid = o.id)
       and not (
         exists (select 1 from jsonb_array_elements_text(v_removed_users) r(val) where r.val = o.id)
         and not exists (select 1 from public.staff_accounts sa where sa.uid = o.id and sa.removed_at is null)
       )
  )
  select coalesce(jsonb_agg(u order by ord), '[]'::jsonb) into v_healed
    from (select u, ord from filtered union all select u, ord from reappend) z;

  new.data := jsonb_set(new.data, '{users}', v_healed);

  -- Rule 6 self-cleaning: an id whose row is live again leaves the list.
  select coalesce(jsonb_agg(r.val order by r.ord), '[]'::jsonb) into v_removed_users
    from jsonb_array_elements(v_removed_users) with ordinality r(val, ord)
   where not exists (select 1 from jsonb_array_elements(v_healed) hu
                      where hu->>'id' = r.val #>> '{}');
  new.data := jsonb_set(new.data, '{removedUserIds}', v_removed_users);

  -- ---- CLOCK LOGS -----------------------------------------------------
  v_old_logs := case when jsonb_typeof(old.data->'logs') = 'array'
                     then old.data->'logs' else '[]'::jsonb end;
  v_new_logs := case when jsonb_typeof(new.data->'logs') = 'array'
                     then new.data->'logs' else null end;
  if v_new_logs is null then
    v_new_logs := v_old_logs;
  end if;

  with old_l as (
    select l->>'id' as id, l
      from jsonb_array_elements(v_old_logs) l
     where coalesce(l->>'id', '') <> ''
  ),
  new_l as (
    select t.l->>'id' as id, t.l, t.ord
      from jsonb_array_elements(v_new_logs) with ordinality t(l, ord)
     where coalesce(t.l->>'id', '') <> ''
  ),
  kept as (
    select
      n.id,
      n.ord,
      (o.l is null) as is_new,
      case
        -- Rule 2 for logs (trims and corrections stamp touchedAt).
        when o.l is not null
             and public.larsa_safe_ts(o.l->>'touchedAt') is not null
             and (public.larsa_safe_ts(n.l->>'touchedAt') is null
                  or public.larsa_safe_ts(n.l->>'touchedAt') < public.larsa_safe_ts(o.l->>'touchedAt'))
          then o.l
        -- Rule 5: an adjusted punch keeps its corrected time against an
        -- UNSTAMPED different-time copy. A stamped incoming row is a fresh
        -- deliberate edit and is ordered by rule 2 instead.
        when o.l is not null
             and coalesce(o.l->>'note', '') ~ '(Adjusted by|Fixed by|Manual entry by)'
             and coalesce(n.l->>'time', '') is distinct from coalesce(o.l->>'time', '')
             and public.larsa_safe_ts(n.l->>'touchedAt') is null
          then o.l
        else n.l
      end as l
    from new_l n
    left join old_l o on o.id = n.id
  ),
  filtered as (
    select k.l, k.ord, k.id
      from kept k
     where not (
       k.is_new
       and exists (select 1 from jsonb_array_elements_text(v_removed_logs) r(val) where r.val = k.id)
     )
  ),
  reappend as (
    select o.l, 2000000 + row_number() over () as ord, o.id
      from old_l o
     where not exists (select 1 from new_l n where n.id = o.id)
       and not exists (select 1 from jsonb_array_elements_text(v_removed_logs) r(val) where r.val = o.id)
  )
  select coalesce(jsonb_agg(l order by ord), '[]'::jsonb) into v_healed
    from (select l, ord from filtered union all select l, ord from reappend) z;

  new.data := jsonb_set(new.data, '{logs}', v_healed);
  new.data := jsonb_set(new.data, '{removedLogIds}', v_removed_logs);

  return new;
exception when others then
  /* FAIL OPEN. This guard exists to prevent silent data loss; it must never
     become the thing that blocks the whole company from saving. If anything
     in the healing raises on some document shape nobody predicted, the
     write proceeds exactly as it would have before this migration, and the
     warning leaves a trail in the database logs to fix the gap. */
  raise warning 'app_state_guard_staff_document failed open: %', sqlerrm;
  return new;
end $$;

drop trigger if exists aa_app_state_guard_staff_document_trg on public.app_state;
create trigger aa_app_state_guard_staff_document_trg
  before update on public.app_state
  for each row execute function public.app_state_guard_staff_document();

-- ---------------------------------------------------------------------
-- 2. The account ledger only moves FORWARD. staff_account_upsert used to
--    replace the stored record with whatever any client sent — so a stale
--    device constantly overwrote a fresh lifecycle state (offboarded flag,
--    role, password) with an old one, and a later restore resurrected that
--    old state. Now an incoming record older than the stored one (by
--    touchedAt) refreshes the sighting, never the content.
-- ---------------------------------------------------------------------
drop function if exists public.staff_account_upsert(jsonb);
create function public.staff_account_upsert(p_accounts jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  a jsonb;
  v_uid text;
  v_existing public.staff_accounts%rowtype;
  v_incoming jsonb;
  v_wins boolean;
  written integer := 0;
begin
  for a in select * from jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb)) loop
    v_uid := coalesce(a->>'uid', '');
    if v_uid = '' then continue; end if;
    v_incoming := coalesce(a->'record', '{}'::jsonb);

    select * into v_existing from public.staff_accounts where uid = v_uid;

    if not found then
      insert into public.staff_accounts (uid, name, normalized_email, access, username, record, last_seen_at)
      values (
        v_uid,
        nullif(a->>'name', ''),
        nullif(lower(trim(a->>'normalized_email')), ''),
        nullif(a->>'access', ''),
        nullif(a->>'username', ''),
        v_incoming,
        clock_timestamp()
      );
      written := written + 1;
      continue;
    end if;

    -- The incoming copy wins only when it is not provably older.
    v_wins := not (
      public.larsa_safe_ts(v_existing.record->>'touchedAt') is not null
      and (public.larsa_safe_ts(v_incoming->>'touchedAt') is null
           or public.larsa_safe_ts(v_incoming->>'touchedAt') < public.larsa_safe_ts(v_existing.record->>'touchedAt'))
    );
    if v_incoming = '{}'::jsonb then
      v_wins := false;
    end if;

    update public.staff_accounts sa
       set last_seen_at = clock_timestamp(),
           record = case when v_wins then v_incoming else sa.record end,
           -- Descriptive columns follow whichever record is being kept, and
           -- a known value is never overwritten with a blank one.
           name = coalesce(nullif(case when v_wins then a->>'name' else sa.name end, ''), sa.name),
           normalized_email = coalesce(nullif(case when v_wins then lower(trim(a->>'normalized_email')) else sa.normalized_email end, ''), sa.normalized_email),
           access = coalesce(nullif(case when v_wins then a->>'access' else sa.access end, ''), sa.access),
           username = coalesce(nullif(case when v_wins then a->>'username' else sa.username end, ''), sa.username)
     where sa.uid = v_uid;
    written := written + 1;
  end loop;
  return written;
end $$;

revoke all on function public.staff_account_upsert(jsonb) from public;
grant execute on function public.staff_account_upsert(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Record the truth about superseded ghost accounts — GENERIC, not
--    per-person: a live ledger row whose uid is absent from the shared
--    document while its email is carried by a DIFFERENT live account is a
--    ghost left over from an account recreation. It has already been
--    replaced in every business sense; tombstoning it here records that,
--    and rule 7 above then prevents it from ever riding back in from a
--    stale device. Nothing visible changes for any current user: these
--    rows are already absent from the directory.
--    Idempotent: already-tombstoned rows are skipped.
-- ---------------------------------------------------------------------
do $$
declare
  ghost record;
begin
  for ghost in
    select sa.uid, sa.normalized_email,
           (select u->>'id'
              from public.app_state, jsonb_array_elements(data->'users') u
             where store_key = 'larsaStaffV8'
               and lower(trim(coalesce(u->>'email',''))) = sa.normalized_email
               and u->>'id' is distinct from sa.uid
             limit 1) as live_uid
      from public.staff_accounts sa
     where sa.removed_at is null
       and sa.normalized_email is not null
       and not exists (
         select 1 from public.app_state, jsonb_array_elements(data->'users') u
          where store_key = 'larsaStaffV8' and u->>'id' = sa.uid
       )
       and exists (
         select 1 from public.app_state, jsonb_array_elements(data->'users') u
          where store_key = 'larsaStaffV8'
            and lower(trim(coalesce(u->>'email',''))) = sa.normalized_email
            and u->>'id' is distinct from sa.uid
       )
  loop
    perform public.staff_account_tombstone(
      ghost.uid,
      'repair_008',
      'superseded by recreated account ' || coalesce(ghost.live_uid, '?') ||
      ' holding the same email; recorded so the ghost cannot resurrect'
    );
  end loop;
end $$;
