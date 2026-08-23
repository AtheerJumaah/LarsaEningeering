-- ============================================================
-- Larsa Control — repair_008 server guard tests
-- (migration repair_008_server_guard_stale_writes.sql)
--
-- The database no longer trusts stale documents. Rules under test, each
-- replaying a production failure:
--   * a punch or account that leaves the document WITHOUT a tombstone is
--     healed straight back (the Aug 18–22 losses: 99 punches missing);
--   * a tombstoned row stays gone, and cannot ride back in from a stale
--     device's copy;
--   * tombstone lists union — a stale shorter list cannot shrink them
--     (how repair_005's removedLogIds were wiped);
--   * a strictly older stamped record never replaces a newer one;
--   * a hashed password/PIN never regresses against its change stamp
--     ("my new password stopped working two days later");
--   * emailVerified never silently reverts while the email is unchanged
--     (the needless verification codes at every sign-in);
--   * an adjusted clock-out keeps its corrected time against an unstamped
--     rewrite (admins were re-trimming the same sessions daily);
--   * a hollow document (no users array) cannot empty the directory;
--   * staff_account_upsert only moves the ledger record FORWARD;
--   * the superseded-ghost sweep tombstones exactly the right rows.
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
  doc jsonb;
  got jsonb;
  n int;
begin
  -- Baseline document: two users (one stamped, one not), two punches, and
  -- one adjusted clock-out.
  update app_state set data = jsonb_build_object(
    'users', jsonb_build_array(
      jsonb_build_object('id','u1','name','Alice','access','Engineer',
                         'email','alice@larsaeng.com','emailVerified',true,
                         'password','pbkdf2$210000$saltA$hashA',
                         'passwordChangedAt','2026-08-20T10:00:00Z',
                         'touchedAt','2026-08-20T10:00:00Z'),
      jsonb_build_object('id','u2','name','Basim','access','Engineer',
                         'email','basim@larsaeng.com')
    ),
    'logs', jsonb_build_array(
      jsonb_build_object('id','lIn','uid','u1','status','In','type','Online','time','2026-08-21T08:00:00Z'),
      jsonb_build_object('id','lOut','uid','u1','status','Out','type','Online','time','2026-08-21T15:00:00Z',
                         'note','Adjusted by Admin on 8/21/2026')
    ),
    'removedLogIds', jsonb_build_array('deadL'),
    'removedUserIds', '[]'::jsonb
  ), updated_by = 'test-baseline'
  where store_key = 'larsaStaffV8';
  if not found then
    insert into app_state (store_key, data) values ('larsaStaffV8', '{}'::jsonb);
    update app_state set data = jsonb_build_object(
      'users', jsonb_build_array(
        jsonb_build_object('id','u1','name','Alice','access','Engineer',
                           'email','alice@larsaeng.com','emailVerified',true,
                           'password','pbkdf2$210000$saltA$hashA',
                           'passwordChangedAt','2026-08-20T10:00:00Z',
                           'touchedAt','2026-08-20T10:00:00Z'),
        jsonb_build_object('id','u2','name','Basim','access','Engineer',
                           'email','basim@larsaeng.com')
      ),
      'logs', jsonb_build_array(
        jsonb_build_object('id','lIn','uid','u1','status','In','type','Online','time','2026-08-21T08:00:00Z'),
        jsonb_build_object('id','lOut','uid','u1','status','Out','type','Online','time','2026-08-21T15:00:00Z',
                           'note','Adjusted by Admin on 8/21/2026')
      ),
      'removedLogIds', jsonb_build_array('deadL'),
      'removedUserIds', '[]'::jsonb
    ) where store_key = 'larsaStaffV8';
  end if;

  -- ----------------------------------------------------------
  -- 1. A stale save that lost the clock-out gets it healed back.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{logs}', jsonb_build_array(doc->'logs'->0))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('1. a dropped clock-out is healed back (no tombstone, no deletion)',
    exists (select 1 from jsonb_array_elements(got->'logs') l where l->>'id' = 'lOut'));

  -- ----------------------------------------------------------
  -- 2. A deliberate removal (tombstoned in the SAME save) stays removed,
  --    and the union keeps the pre-existing tombstone too.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(
                  jsonb_set(doc, '{logs}', jsonb_build_array(doc->'logs'->0)),
                  '{removedLogIds}', '["deadL","lOut"]'::jsonb)
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('2a. a tombstoned removal is honoured',
    not exists (select 1 from jsonb_array_elements(got->'logs') l where l->>'id' = 'lOut'));
  perform pg_temp.chk('2b. the tombstone list keeps both entries',
    got->'removedLogIds' @> '["deadL","lOut"]'::jsonb);

  -- ----------------------------------------------------------
  -- 3. A stale device still carrying the removed row cannot resurrect it,
  --    and its stale SHORTER tombstone list cannot shrink the union.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(
                  jsonb_set(doc, '{logs}',
                    (doc->'logs') || jsonb_build_array(
                      jsonb_build_object('id','lOut','uid','u1','status','Out','type','Online','time','2026-08-21T16:30:00Z'))),
                  '{removedLogIds}', '["deadL"]'::jsonb)
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('3a. a tombstoned punch cannot ride back in from a stale copy',
    not exists (select 1 from jsonb_array_elements(got->'logs') l where l->>'id' = 'lOut'));
  perform pg_temp.chk('3b. the tombstone union cannot be shrunk by a stale list',
    got->'removedLogIds' @> '["deadL","lOut"]'::jsonb);

  -- ----------------------------------------------------------
  -- 4. A strictly older stamped user record loses to the newer one.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users}', jsonb_build_array(
        jsonb_build_object('id','u1','name','Alice','access','Admin',
                           'email','alice@larsaeng.com',
                           'touchedAt','2026-08-19T09:00:00Z'),
        doc->'users'->1))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('4. an older stamped record cannot replace a newer one',
    (select u->>'access' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1') = 'Engineer');

  -- ----------------------------------------------------------
  -- 5. Password regression guard: a different hash with an older/missing
  --    change stamp is refused; a NEWER change stamp is accepted.
  -- ----------------------------------------------------------
  -- NOTE the parentheses: jsonb `-` binds tighter than `||` in PostgreSQL,
  -- so without them the stamp would never actually be removed.
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users,0}',
        ((doc->'users'->0)
         || jsonb_build_object('password','pbkdf2$210000$saltOLD$hashOLD'))
        - 'passwordChangedAt')
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('5a. an unstamped different hash cannot replace a stamped one',
    (select u->>'password' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1')
      = 'pbkdf2$210000$saltA$hashA');

  -- An equal-stamp different hash is a replayed stale copy: refused too.
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users,0}',
        (doc->'users'->0)
        || jsonb_build_object('password','pbkdf2$210000$saltREPLAY$hashREPLAY',
                              'passwordChangedAt','2026-08-20T10:00:00Z'))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('5a2. an equal-stamp different hash is refused as a replay',
    (select u->>'password' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1')
      = 'pbkdf2$210000$saltA$hashA');

  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users,0}',
        (doc->'users'->0)
        || jsonb_build_object('password','pbkdf2$210000$saltNEW$hashNEW',
                              'passwordChangedAt','2026-08-22T09:00:00Z',
                              'touchedAt','2026-08-22T09:00:00Z'))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('5b. a genuinely newer password change is accepted',
    (select u->>'password' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1')
      = 'pbkdf2$210000$saltNEW$hashNEW');

  -- ----------------------------------------------------------
  -- 6. emailVerified cannot silently revert while the email is unchanged —
  --    but a genuine email change may reset it.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users,0}',
        (doc->'users'->0) || jsonb_build_object('emailVerified', false, 'touchedAt','2026-08-22T09:30:00Z'))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('6a. emailVerified does not revert while the address is unchanged',
    (select u->>'emailVerified' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1') = 'true');

  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users,0}',
        (doc->'users'->0) || jsonb_build_object('email','alice.new@larsaeng.com',
                                                'emailVerified', false,
                                                'touchedAt','2026-08-22T09:45:00Z'))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('6b. a real email change may reset the flag (re-verification is correct there)',
    (select u->>'emailVerified' from jsonb_array_elements(got->'users') u where u->>'id' = 'u1') = 'false');

  -- ----------------------------------------------------------
  -- 7. An adjusted clock-out keeps its corrected time against an unstamped
  --    different-time rewrite. (Recreate an adjusted out-row first.)
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{logs}',
        (doc->'logs') || jsonb_build_array(
          jsonb_build_object('id','lOut2','uid','u2','status','Out','type','Office',
                             'time','2026-08-21T14:00:00Z',
                             'note','Adjusted by Admin on 8/21/2026',
                             'touchedAt','2026-08-21T14:05:00Z')))
   where store_key = 'larsaStaffV8';
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{logs}',
        (select jsonb_agg(case when l->>'id' = 'lOut2'
                               then (l - 'touchedAt') || jsonb_build_object('time','2026-08-21T19:00:00Z')
                               else l end)
           from jsonb_array_elements(doc->'logs') l))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('7. a trimmed clock-out keeps its corrected time against an unstamped rewrite',
    (select l->>'time' from jsonb_array_elements(got->'logs') l where l->>'id' = 'lOut2')
      = '2026-08-21T14:00:00Z');

  -- ----------------------------------------------------------
  -- 8. A hollow document (users missing entirely) cannot empty the
  --    directory; the logs equivalent holds too.
  -- ----------------------------------------------------------
  update app_state set data = '{"theme":"dark"}'::jsonb where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  select count(*) into n from jsonb_array_elements(got->'users');
  perform pg_temp.chk('8a. a document without a users array cannot hollow out the directory', n >= 2);
  select count(*) into n from jsonb_array_elements(got->'logs');
  perform pg_temp.chk('8b. nor can it hollow out the clock logs', n >= 1);

  -- ----------------------------------------------------------
  -- 9. Account deletion: absence alone is healed back; a staff_accounts
  --    tombstone makes it stick, and blocks resurrection afterwards.
  -- ----------------------------------------------------------
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users}',
        (select jsonb_agg(u) from jsonb_array_elements(doc->'users') u where u->>'id' <> 'u2'))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('9a. an account that vanishes without evidence is healed back',
    exists (select 1 from jsonb_array_elements(got->'users') u where u->>'id' = 'u2'));

  insert into staff_accounts (uid, name, normalized_email, access, record)
  values ('u2', 'Basim', 'basim@larsaeng.com', 'Engineer', '{"id":"u2","name":"Basim"}'::jsonb)
  on conflict (uid) do nothing;
  perform staff_account_tombstone('u2', 'test', 'deliberate delete');

  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(
                  jsonb_set(doc, '{users}',
                    (select jsonb_agg(u) from jsonb_array_elements(doc->'users') u where u->>'id' <> 'u2')),
                  '{removedUserIds}', '["u2"]'::jsonb)
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('9b. a tombstoned delete is honoured',
    not exists (select 1 from jsonb_array_elements(got->'users') u where u->>'id' = 'u2'));

  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{users}',
        (doc->'users') || jsonb_build_array(jsonb_build_object('id','u2','name','Basim (stale copy)')))
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  perform pg_temp.chk('9c. a deleted account cannot ride back in from a stale device',
    not exists (select 1 from jsonb_array_elements(got->'users') u where u->>'id' = 'u2'));

  -- ----------------------------------------------------------
  -- 10. The bypass switch: server-side maintenance can opt out.
  -- ----------------------------------------------------------
  perform set_config('larsa.guard_bypass', 'yes', true);
  select data into doc from app_state where store_key = 'larsaStaffV8';
  update app_state
     set data = jsonb_set(doc, '{logs}', '[]'::jsonb)
   where store_key = 'larsaStaffV8';
  select data into got from app_state where store_key = 'larsaStaffV8';
  select count(*) into n from jsonb_array_elements(got->'logs');
  perform pg_temp.chk('10. guard_bypass lets deliberate maintenance through', n = 0);
  perform set_config('larsa.guard_bypass', 'no', true);

  raise notice 'ALL REPAIR-GUARD DOCUMENT TESTS PASSED';
end $$;

-- ----------------------------------------------------------
-- staff_account_upsert: the ledger record only moves forward.
-- ----------------------------------------------------------
do $$
declare
  rec jsonb;
  seen_before timestamptz;
begin
  perform staff_account_upsert(jsonb_build_array(jsonb_build_object(
    'uid','led1','name','Newer Name','normalized_email','led1@larsaeng.com','access','Admin','username','led1',
    'record', jsonb_build_object('id','led1','name','Newer Name','access','Admin','touchedAt','2026-08-22T10:00:00Z'))));

  select last_seen_at into seen_before from staff_accounts where uid = 'led1';

  -- A stale device sends the OLD copy: sighting refreshes, content does not move back.
  perform pg_sleep(0.01);
  perform staff_account_upsert(jsonb_build_array(jsonb_build_object(
    'uid','led1','name','Old Name','normalized_email','led1@larsaeng.com','access','Engineer','username','led1',
    'record', jsonb_build_object('id','led1','name','Old Name','access','Engineer','touchedAt','2026-08-20T10:00:00Z'))));

  select record into rec from staff_accounts where uid = 'led1';
  perform pg_temp.chk('11a. an older record cannot overwrite a newer ledger copy',
    rec->>'access' = 'Admin' and rec->>'name' = 'Newer Name');
  perform pg_temp.chk('11b. the stale sighting still bumps last_seen_at',
    (select last_seen_at from staff_accounts where uid = 'led1') > seen_before);
  perform pg_temp.chk('11c. descriptive columns follow the kept record',
    (select access from staff_accounts where uid = 'led1') = 'Admin');

  -- A genuinely newer record moves it forward.
  perform staff_account_upsert(jsonb_build_array(jsonb_build_object(
    'uid','led1','name','Newest','normalized_email','led1@larsaeng.com','access','Admin HR','username','led1',
    'record', jsonb_build_object('id','led1','name','Newest','access','Admin HR','touchedAt','2026-08-23T10:00:00Z'))));
  select record into rec from staff_accounts where uid = 'led1';
  perform pg_temp.chk('11d. a newer record does move the ledger forward',
    rec->>'access' = 'Admin HR');

  -- An unstamped incoming record against an unstamped stored one is accepted
  -- (older clients keep working during the rollout).
  perform staff_account_upsert(jsonb_build_array(jsonb_build_object(
    'uid','led2','name','First','normalized_email','led2@larsaeng.com','access','Engineer','username','led2',
    'record', jsonb_build_object('id','led2','name','First'))));
  perform staff_account_upsert(jsonb_build_array(jsonb_build_object(
    'uid','led2','name','Second','normalized_email','led2@larsaeng.com','access','Engineer','username','led2',
    'record', jsonb_build_object('id','led2','name','Second'))));
  select record into rec from staff_accounts where uid = 'led2';
  perform pg_temp.chk('11e. unstamped-over-unstamped still updates (old clients unharmed)',
    rec->>'name' = 'Second');

  raise notice 'ALL LEDGER-RECENCY TESTS PASSED';
end $$;

-- ----------------------------------------------------------
-- The superseded-ghost sweep (part 3 of repair_008): generic, and precise.
-- ----------------------------------------------------------
do $$
declare
  ghost_removed timestamptz;
  keeper_removed timestamptz;
begin
  -- ghostA is absent from the document while its email lives on under a new
  -- uid -> must be tombstoned by the sweep. keeperB is absent but its email
  -- is not reused -> must be left alone (it is the account ledger's job to
  -- offer it back, not the sweep's to bury it).
  update app_state set data = jsonb_set(coalesce(data,'{}'::jsonb), '{users}', jsonb_build_array(
    jsonb_build_object('id','uNew','name','Recreated','email','ghost@larsaeng.com')
  )) where store_key = 'larsaStaffV8';

  insert into staff_accounts (uid, name, normalized_email, access, record)
  values ('ghostA', 'Ghost', 'ghost@larsaeng.com', 'Engineer', '{"id":"ghostA"}'::jsonb)
  on conflict (uid) do nothing;
  insert into staff_accounts (uid, name, normalized_email, access, record)
  values ('keeperB', 'Keeper', 'keeper@larsaeng.com', 'Engineer', '{"id":"keeperB"}'::jsonb)
  on conflict (uid) do nothing;

  -- Re-run the sweep exactly as the migration ships it.
  perform public.staff_account_tombstone(
      sa.uid, 'repair_008',
      'superseded by recreated account holding the same email; recorded so the ghost cannot resurrect')
    from public.staff_accounts sa
   where sa.removed_at is null
     and sa.normalized_email is not null
     and not exists (
       select 1 from public.app_state, jsonb_array_elements(data->'users') u
        where store_key = 'larsaStaffV8' and u->>'id' = sa.uid)
     and exists (
       select 1 from public.app_state, jsonb_array_elements(data->'users') u
        where store_key = 'larsaStaffV8'
          and lower(trim(coalesce(u->>'email',''))) = sa.normalized_email
          and u->>'id' is distinct from sa.uid);

  select removed_at into ghost_removed from staff_accounts where uid = 'ghostA';
  select removed_at into keeper_removed from staff_accounts where uid = 'keeperB';
  perform pg_temp.chk('12a. a ghost superseded by a same-email recreation is tombstoned', ghost_removed is not null);
  perform pg_temp.chk('12b. an absent account whose email is NOT reused is left alone', keeper_removed is null);

  raise notice 'ALL GHOST-SWEEP TESTS PASSED';
end $$;

select 'REPAIR GUARD SQL TESTS COMPLETE' as done;
rollback;
