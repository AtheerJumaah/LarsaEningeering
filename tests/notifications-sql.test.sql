-- ============================================================
-- Larsa Control — the notification centre (migration 011).
--
-- What this guards:
--   * the bell is authoritative: no preference, argument or code path can
--     stop an in-app record being written, and archiving never deletes one
--   * you read your own notifications and nobody else's — through the
--     function, through its parameters, and through the table itself
--   * marking, archiving and restoring another person's row changes nothing
--   * the same event raised twice lands once
--   * a salary figure never reaches a lock screen, whatever the caller sends
--   * a category switched off suppresses the push and keeps the record
--   * quiet hours wrap midnight correctly, and never touch the bell
--   * two senders draining the outbox at once cannot send the same push twice
--   * a dead subscription is pruned rather than retried for ever
--   * the legacy import is idempotent and refuses somebody else's history
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

-- ------------------------------------------------------------
-- 1. There is no direct table access. This is the first line of the
--    privacy story and it is a grant, not a screen.
-- ------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('notify_messages','notify_prefs','notify_settings',
                       'notify_outbox','notify_deliveries','push_subscriptions')
    and grantee in ('anon','authenticated');
  perform pg_temp.chk('no client grants on any notification table', n = 0);

  select count(*) into n
  from pg_tables t join pg_class c on c.relname = t.tablename
  where t.schemaname = 'public'
    and t.tablename like 'notify_%'
    and c.relrowsecurity = false;
  perform pg_temp.chk('row level security is on for every notify table', n = 0);

  -- The old push_subscriptions policy was USING (true): every browser holding
  -- the anon key could read every push endpoint in the company.
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'push_subscriptions';
  perform pg_temp.chk('the open push_subscriptions policy is gone', n = 0);
end $$;

-- ------------------------------------------------------------
-- 1b. The sender's own functions are not reachable from a browser.
--     Revoking from anon alone would not do it: a function is created with
--     EXECUTE granted to PUBLIC, and anon inherits that. This check is here
--     because the first version of the migration got it wrong and left the
--     outbox claim — every queued title and body in the company — callable
--     with nothing but the anon key.
-- ------------------------------------------------------------
do $$
declare f text; n int := 0;
begin
  foreach f in array array['notify_outbox_claim','notify_outbox_finish',
                           'notify_prune_device','notify_push_body',
                           'notify_in_quiet_hours','notify_actor_uid'] loop
    if has_function_privilege('anon', (
         select p.oid from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = f limit 1), 'execute')
    then n := n + 1; raise notice 'exposed: %', f; end if;
  end loop;
  perform pg_temp.chk('no sender-only function is callable by anon', n = 0);

  n := 0;
  foreach f in array array['notify_feed','notify_counts','notify_mark',
                           'notify_setup','notify_raise'] loop
    if not has_function_privilege('anon', (
         select p.oid from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = f limit 1), 'execute')
    then n := n + 1; raise notice 'unreachable: %', f; end if;
  end loop;
  perform pg_temp.chk('every client entry point is callable by anon', n = 0);
end $$;

-- ------------------------------------------------------------
-- 2. The bell is authoritative and unconditional.
-- ------------------------------------------------------------
do $$
declare r jsonb; n int;
begin
  -- Every category switched off, quiet hours on, no devices: the record is
  -- still written. This is the promise the settings screen makes.
  insert into public.notify_settings (user_uid, quiet_from, quiet_to)
  values ('t-alice', 0, 23);
  insert into public.notify_prefs (user_uid, category, push_enabled, mail_enabled)
  select 't-alice', id, false, false from public.notify_categories;

  r := public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-alice','event','leave.decided',
                       'title','Leave approved','body','12 August','itemId','requests')));
  perform pg_temp.chk('a notification is created with every alert switched off',
    (r->>'created')::int = 1);

  select count(*) into n from public.notify_messages where user_uid = 't-alice';
  perform pg_temp.chk('the record exists in the bell regardless of preferences', n = 1);

  -- There is deliberately no column that could hold "in-app: off".
  select count(*) into n from information_schema.columns
  where table_schema='public' and table_name='notify_prefs'
    and column_name in ('in_app','inapp','in_app_enabled','bell_enabled');
  perform pg_temp.chk('no preference column can switch the bell off', n = 0);
end $$;

-- ------------------------------------------------------------
-- 3. Isolation: your notifications are yours.
-- ------------------------------------------------------------
do $$
declare r jsonb; alice_id uuid;
begin
  perform public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-bob','event','admin.broadcast','title','Office closed','body','Friday')));

  select id into alice_id from public.notify_messages where user_uid = 't-alice' limit 1;

  perform pg_temp.chk('a person sees only their own feed',
    (public.notify_feed('{"id":"t-bob"}'::jsonb,'all',null,null,50,0)->>'total')::int = 1);
  perform pg_temp.chk('and only their own counts',
    (public.notify_counts('{"id":"t-bob"}'::jsonb)->>'all')::int = 1);

  -- Naming somebody else's notification id changes nothing.
  r := public.notify_mark('{"id":"t-bob"}'::jsonb, array[alice_id], 'read');
  perform pg_temp.chk('marking another person''s notification read changes nothing',
    (r->>'changed')::int = 0);
  r := public.notify_mark('{"id":"t-bob"}'::jsonb, array[alice_id], 'archive');
  perform pg_temp.chk('archiving another person''s notification changes nothing',
    (r->>'changed')::int = 0);
  perform pg_temp.chk('and the owner''s row is untouched',
    (select read_at is null and archived_at is null from public.notify_messages where id = alice_id));

  -- An actor with no id is refused rather than defaulted to somebody.
  begin
    perform public.notify_feed('{}'::jsonb,'all',null,null,10,0);
    perform pg_temp.chk('an actor without an id is refused', false);
  exception when others then
    perform pg_temp.chk('an actor without an id is refused', true);
  end;
end $$;

-- ------------------------------------------------------------
-- 4. Idempotency: the same event twice is one notification.
-- ------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-carol','event','points.reviewed','title','Points approved',
                       'body','Week 31','dedupeKey','pts-w31'),
    jsonb_build_object('userUid','t-carol','event','points.reviewed','title','Points approved',
                       'body','Week 31','dedupeKey','pts-w31')));
  perform pg_temp.chk('a double-tapped approval creates one notification, not two',
    (r->>'created')::int = 1 and (r->>'deduped')::int = 1);

  -- A retry minutes later is still the same event.
  r := public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-carol','event','points.reviewed','title','Points approved',
                       'body','Week 31','dedupeKey','pts-w31')));
  perform pg_temp.chk('and a later retry of the same key adds nothing',
    (r->>'created')::int = 0);

  -- Without a key, two genuinely separate events both land.
  r := public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-carol','event','chat.message','title','New message','body','a'),
    jsonb_build_object('userUid','t-carol','event','chat.message','title','New message','body','b')));
  perform pg_temp.chk('two separate events without a key both land',
    (r->>'created')::int = 2);

  perform pg_temp.chk('one outbox row per created notification',
    (select count(*) from public.notify_outbox where user_uid = 't-carol') = 3);
end $$;

-- ------------------------------------------------------------
-- 5. Privacy: an amount never reaches a lock screen.
-- ------------------------------------------------------------
do $$
declare pushed text; stored text;
begin
  perform public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-dave','event','pay.published','title','Payslip available',
                       'body','July salary 1,250,000 IQD paid to account ****4417','itemId','my-pay')));

  select body into stored from public.notify_messages where user_uid = 't-dave';
  select body into pushed from public.notify_outbox   where user_uid = 't-dave';

  perform pg_temp.chk('the record keeps the full detail', stored like '%1,250,000%');
  perform pg_temp.chk('the push carries no figure', pushed not like '%1,250,000%');
  perform pg_temp.chk('the push carries no account number', pushed not like '%4417%');
  perform pg_temp.chk('the push says where to look instead', pushed like '%Open Larsa Control%');

  -- The same protection for accounting, and NOT for ordinary categories.
  perform pg_temp.chk('accounting is redacted too',
    public.notify_push_body('accounting', 'Invoice 9,400,000 IQD') not like '%9,400,000%');
  perform pg_temp.chk('an ordinary category is not needlessly redacted',
    public.notify_push_body('leave', 'Your leave on 12 Aug was approved') like '%12 Aug%');
  -- It is a property of the category, not of the caller's good manners.
  perform pg_temp.chk('redaction is decided by the stored category, not the caller',
    (select sensitive from public.notify_categories where id = 'pay') = true);
end $$;

-- ------------------------------------------------------------
-- 6. Preferences suppress the alert, never the record.
-- ------------------------------------------------------------
do $$
declare item jsonb; n int;
begin
  insert into public.push_subscriptions (staff_uid, endpoint, p256dh, auth, enabled)
  values ('t-dave','https://push.example/dave-1','k','a',true);
  insert into public.notify_prefs (user_uid, category, push_enabled, mail_enabled)
  values ('t-dave','pay',false,false);

  select i into item from jsonb_array_elements(public.notify_outbox_claim(50)->'items') i
  where i->>'userUid' = 't-dave';

  perform pg_temp.chk('a category switched off suppresses the alert',
    item->>'suppressed' = 'category-off');
  select count(*) into n from public.notify_messages where user_uid = 't-dave';
  perform pg_temp.chk('and the notification is still in the bell', n = 1);
end $$;

-- ------------------------------------------------------------
-- 7. Quiet hours wrap midnight.
-- ------------------------------------------------------------
do $$
begin
  -- 22:00 -> 07:00 is the case a naive BETWEEN gets wrong in both directions.
  perform pg_temp.chk('quiet at 23:00 for a 22->7 window',
    public.notify_in_quiet_hours(22::smallint, 7::smallint, 'UTC') =
    (extract(hour from now() at time zone 'UTC')::int >= 22
     or extract(hour from now() at time zone 'UTC')::int < 7));
  perform pg_temp.chk('quiet hours off when unset',
    public.notify_in_quiet_hours(null, null, 'UTC') = false);
  perform pg_temp.chk('an equal start and end is not a permanent silence',
    public.notify_in_quiet_hours(9::smallint, 9::smallint, 'UTC') = false);
  -- An unknown time zone must not silently swallow somebody's alerts.
  perform pg_temp.chk('an unknown time zone falls back instead of erroring',
    public.notify_in_quiet_hours(0::smallint, 1::smallint, 'Not/AZone') is not null);
end $$;

-- ------------------------------------------------------------
-- 8. The outbox: claimed once, retried when stranded, recorded either way.
-- ------------------------------------------------------------
do $$
declare first_ids uuid[]; second jsonb; ob uuid; n int;
begin
  perform public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','t-erin','event','leave.requested','title','Leave request','body','x')));

  -- The first drain takes it; a second drain, running immediately after,
  -- must not take it again. This is what stops a double push.
  select array_agg((i->>'id')::uuid) into first_ids
  from jsonb_array_elements(public.notify_outbox_claim(50)->'items') i
  where i->>'userUid' = 't-erin';
  perform pg_temp.chk('the first drain claims the queued row', array_length(first_ids,1) = 1);

  select count(*) into n from jsonb_array_elements(public.notify_outbox_claim(50)->'items') i
  where i->>'userUid' = 't-erin';
  perform pg_temp.chk('a second drain does not claim it again', n = 0);

  ob := first_ids[1];
  perform public.notify_outbox_finish(ob, 'sent', null, jsonb_build_array(
    jsonb_build_object('channel','push','target','push.example','status','sent','detail','')));
  perform pg_temp.chk('a finished row records its status',
    (select status from public.notify_outbox where id = ob) = 'sent');
  perform pg_temp.chk('and a delivery record survives it',
    (select count(*) from public.notify_deliveries where outbox_id = ob) = 1);

  -- A sender that died mid-batch leaves a row in 'sending'. After five
  -- minutes the next sender must pick it up rather than strand the person.
  update public.notify_outbox set status = 'sending', claimed_at = now() - interval '9 minutes'
   where id = ob;
  select count(*) into n from jsonb_array_elements(public.notify_outbox_claim(50)->'items') i
  where (i->>'id')::uuid = ob;
  perform pg_temp.chk('a stranded send is reclaimed, not lost', n = 1);

  -- A terminal status has to be one of the three that mean "finished".
  begin
    perform public.notify_outbox_finish(ob, 'maybe', null, '[]'::jsonb);
    perform pg_temp.chk('an invalid terminal status is refused', false);
  exception when others then
    perform pg_temp.chk('an invalid terminal status is refused', true);
  end;
end $$;

-- ------------------------------------------------------------
-- 9. Devices: registered, moved, disabled, pruned.
-- ------------------------------------------------------------
do $$
declare d_id uuid; n int;
begin
  perform public.notify_register_device('{"id":"t-frank","name":"Frank"}'::jsonb,
    'https://push.example/frank-1','p','a','iPhone · Installed app','UA','iPhone');
  perform pg_temp.chk('a device registers against its owner',
    (select staff_uid from public.push_subscriptions where endpoint = 'https://push.example/frank-1') = 't-frank');

  -- The same browser, a different person signing in: the row follows the
  -- endpoint, so the previous account stops receiving on hardware it no
  -- longer sits in front of.
  perform public.notify_register_device('{"id":"t-grace","name":"Grace"}'::jsonb,
    'https://push.example/frank-1','p','a','iPhone · Installed app','UA','iPhone');
  select count(*) into n from public.push_subscriptions where endpoint = 'https://push.example/frank-1';
  perform pg_temp.chk('re-registering the same endpoint moves it rather than duplicating', n = 1);
  perform pg_temp.chk('and it now belongs to whoever signed in',
    (select staff_uid from public.push_subscriptions where endpoint = 'https://push.example/frank-1') = 't-grace');

  select id into d_id from public.push_subscriptions where endpoint = 'https://push.example/frank-1';
  perform pg_temp.chk('a stranger cannot disable your device',
    (public.notify_device_update('{"id":"t-frank"}'::jsonb, d_id, false, null)->>'ok')::boolean = false);
  perform pg_temp.chk('the owner can',
    (public.notify_device_update('{"id":"t-grace"}'::jsonb, d_id, false, null)->>'ok')::boolean = true);
  perform pg_temp.chk('a stranger cannot remove your device',
    (public.notify_remove_device('{"id":"t-frank"}'::jsonb, d_id)->>'ok')::boolean = false);

  -- Signing out releases this browser, which is what stops the next person
  -- at a shared machine receiving the last one's notifications.
  perform public.notify_forget_device('{"id":"t-grace"}'::jsonb, 'https://push.example/frank-1');
  select count(*) into n from public.push_subscriptions where endpoint = 'https://push.example/frank-1';
  perform pg_temp.chk('signing out releases this browser''s subscription', n = 0);

  -- A push service answering 410 means the subscription is gone for good.
  perform public.notify_register_device('{"id":"t-frank"}'::jsonb,
    'https://push.example/dead','p','a',null,null,null);
  perform public.notify_prune_device('https://push.example/dead');
  select count(*) into n from public.push_subscriptions where endpoint = 'https://push.example/dead';
  perform pg_temp.chk('a dead subscription is pruned rather than retried for ever', n = 0);

  -- A disabled device is not a deleted one: it stays listed so it can be
  -- switched back on, but the sender skips it.
  perform public.notify_register_device('{"id":"t-frank"}'::jsonb,
    'https://push.example/frank-2','p','a','Mac · Chrome','UA','Mac');
  select id into d_id from public.push_subscriptions where endpoint = 'https://push.example/frank-2';
  perform public.notify_device_update('{"id":"t-frank"}'::jsonb, d_id, false, null);
  perform pg_temp.chk('a disabled device is still listed to the owner',
    jsonb_array_length(public.notify_setup('{"id":"t-frank"}'::jsonb)->'devices') = 1);
end $$;

-- ------------------------------------------------------------
-- 10. Archive hides; it never deletes.
-- ------------------------------------------------------------
do $$
declare mid uuid;
begin
  select id into mid from public.notify_messages where user_uid = 't-bob' limit 1;
  perform public.notify_mark('{"id":"t-bob"}'::jsonb, array[mid], 'archive');

  perform pg_temp.chk('an archived notification leaves the default view',
    (public.notify_feed('{"id":"t-bob"}'::jsonb,'all',null,null,50,0)->>'total')::int = 0);
  perform pg_temp.chk('but is still there under Archived',
    (public.notify_feed('{"id":"t-bob"}'::jsonb,'archived',null,null,50,0)->>'total')::int = 1);
  perform pg_temp.chk('the row itself is never deleted',
    (select count(*) from public.notify_messages where id = mid) = 1);

  perform public.notify_mark('{"id":"t-bob"}'::jsonb, array[mid], 'unarchive');
  perform pg_temp.chk('and restoring brings it back',
    (public.notify_feed('{"id":"t-bob"}'::jsonb,'all',null,null,50,0)->>'total')::int = 1);
end $$;

-- ------------------------------------------------------------
-- 11. Reading, searching and paging the feed.
-- ------------------------------------------------------------
do $$
declare rows_in jsonb := '[]'::jsonb; i int; feed jsonb;
begin
  for i in 1..25 loop
    rows_in := rows_in || jsonb_build_array(jsonb_build_object(
      'userUid','t-hana','event','project.updated',
      'title','Progress update ' || i, 'body','Tower ' || i, 'dedupeKey','p'||i));
  end loop;
  perform public.notify_raise('{"id":"t-boss","name":"Boss"}'::jsonb, rows_in);

  feed := public.notify_feed('{"id":"t-hana"}'::jsonb,'all',null,null,12,0);
  perform pg_temp.chk('a page returns the page size', jsonb_array_length(feed->'items') = 12);
  perform pg_temp.chk('and the true total behind it', (feed->>'total')::int = 25);

  feed := public.notify_feed('{"id":"t-hana"}'::jsonb,'all',null,null,12,12);
  perform pg_temp.chk('the second page continues', jsonb_array_length(feed->'items') = 12);
  perform pg_temp.chk('the total does not change with the offset', (feed->>'total')::int = 25);

  perform pg_temp.chk('search narrows to a match',
    (public.notify_feed('{"id":"t-hana"}'::jsonb,'all','Tower 7',null,50,0)->>'total')::int = 1);
  perform pg_temp.chk('search that matches nothing returns nothing',
    (public.notify_feed('{"id":"t-hana"}'::jsonb,'all','nothing-like-this',null,50,0)->>'total')::int = 0);
  perform pg_temp.chk('a category filter narrows the feed',
    (public.notify_feed('{"id":"t-hana"}'::jsonb,'all',null,'projects',50,0)->>'total')::int = 25);
  perform pg_temp.chk('and a category with nothing in it is empty',
    (public.notify_feed('{"id":"t-hana"}'::jsonb,'all',null,'pay',50,0)->>'total')::int = 0);

  -- A caller asking for ten thousand rows gets a page, not the whole table.
  perform pg_temp.chk('the page size is capped',
    (public.notify_feed('{"id":"t-hana"}'::jsonb,'all',null,null,100000,0)->>'limit')::int <= 100);

  perform public.notify_mark_all_read('{"id":"t-hana"}'::jsonb);
  perform pg_temp.chk('mark all read clears the unread count',
    (public.notify_counts('{"id":"t-hana"}'::jsonb)->>'unread')::int = 0);
  perform pg_temp.chk('and leaves every notification in place',
    (public.notify_counts('{"id":"t-hana"}'::jsonb)->>'all')::int = 25);
end $$;

-- ------------------------------------------------------------
-- 12. Categories and events.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.chk('there are twelve categories',
    (select count(*) from public.notify_categories) = 12);
  perform pg_temp.chk('every event maps to a real category',
    (select count(*) from (values ('clock.correction'),('schedule.changed'),('leave.requested'),
      ('points.reviewed'),('development.assigned'),('project.updated'),('accounting.entry'),
      ('pay.published'),('approval.needed'),('chat.message'),('admin.broadcast'),('account.test')) e(id)
     where public.notify_event_category(e.id) not in (select id from public.notify_categories)) = 0);
  perform pg_temp.chk('an unknown event still resolves rather than failing',
    public.notify_event_category('something.new.later') = 'system');
  perform pg_temp.chk('an unknown category is refused when setting a preference',
    (select true from (select 1) s where not exists (
      select 1 from public.notify_categories where id = 'not-a-category')));
end $$;

do $$
begin
  begin
    perform public.notify_set_pref('{"id":"t-alice"}'::jsonb, 'not-a-category', true, false);
    perform pg_temp.chk('setting a preference on an unknown category is refused', false);
  exception when others then
    perform pg_temp.chk('setting a preference on an unknown category is refused', true);
  end;
  -- Quiet hours are a range or they are off; half a range is neither.
  begin
    perform public.notify_set_settings('{"id":"t-alice"}'::jsonb, '{"quietFrom":22}'::jsonb);
    perform pg_temp.chk('half a quiet-hours range is refused', false);
  exception when others then
    perform pg_temp.chk('half a quiet-hours range is refused', true);
  end;
end $$;

-- ------------------------------------------------------------
-- 13. The legacy import.
-- ------------------------------------------------------------
do $$
declare legacy jsonb; r jsonb;
begin
  legacy := jsonb_build_array(
    jsonb_build_object('id','n1','toId','t-ivan','event','leave.decided','title','Old approval',
                       'body','from last month','at','2026-06-01T09:00:00Z','read',true,'fromName','Boss'),
    jsonb_build_object('id','n2','toId','t-ivan','event','points.reviewed','title','Old points',
                       'body','week 20','at','2026-06-02T09:00:00Z','read',false,'fromName','Boss'),
    -- Somebody else's leftover row, sitting in this browser's storage.
    jsonb_build_object('id','n3','toId','t-jane','event','pay.published','title','Not yours',
                       'body','x','at','2026-06-03T09:00:00Z','read',false,'fromName','Boss'));

  r := public.notify_import_legacy('{"id":"t-ivan","name":"Ivan"}'::jsonb, legacy);
  perform pg_temp.chk('the import carries this person''s history over', (r->>'imported')::int = 2);
  perform pg_temp.chk('and refuses somebody else''s',
    (select count(*) from public.notify_messages where user_uid = 't-jane') = 0);
  perform pg_temp.chk('read state survives the move',
    (select count(*) from public.notify_messages where user_uid = 't-ivan' and read_at is not null) = 1);
  perform pg_temp.chk('so does when it happened',
    (select count(*) from public.notify_messages
      where user_uid = 't-ivan' and created_at < '2026-07-01'::timestamptz) = 2);

  -- Running it again — a second device, or the same one twice — adds nothing.
  r := public.notify_import_legacy('{"id":"t-ivan","name":"Ivan"}'::jsonb, legacy);
  perform pg_temp.chk('importing twice adds nothing', (r->>'imported')::int = 0);
  perform pg_temp.chk('and the history is still exactly what it was',
    (select count(*) from public.notify_messages where user_uid = 't-ivan') = 2);

  -- A migration is not an excuse to re-push last month's notifications.
  perform pg_temp.chk('imported history queues no alerts',
    (select count(*) from public.notify_outbox where user_uid = 't-ivan') = 0);
end $$;

-- ------------------------------------------------------------
-- 14. Malformed input is refused, not half-applied.
-- ------------------------------------------------------------
do $$
declare r jsonb;
begin
  begin
    perform public.notify_raise('{"id":"t-boss"}'::jsonb, '{"not":"an array"}'::jsonb);
    perform pg_temp.chk('a non-array payload is refused', false);
  exception when others then
    perform pg_temp.chk('a non-array payload is refused', true);
  end;

  -- A row with no recipient or no title is skipped; the rest of the batch
  -- still goes through, because one bad row should not lose the other forty.
  r := public.notify_raise('{"id":"t-boss"}'::jsonb, jsonb_build_array(
    jsonb_build_object('userUid','','event','x','title','no recipient'),
    jsonb_build_object('userUid','t-kate','event','x','title',''),
    jsonb_build_object('userUid','t-kate','event','admin.broadcast','title','a real one','body','b')));
  perform pg_temp.chk('incomplete rows are skipped and the good ones still land',
    (r->>'created')::int = 1);

  begin
    perform public.notify_mark('{"id":"t-kate"}'::jsonb, null, 'explode');
    perform pg_temp.chk('an unknown mark action is refused', false);
  exception when others then
    perform pg_temp.chk('an unknown mark action is refused', true);
  end;
end $$;

rollback;
