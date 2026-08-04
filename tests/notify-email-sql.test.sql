-- Larsa Control — the email channel, proven against the real functions.
--
-- The point of these is the word "independent". It is easy to write a second
-- channel that is really a flag on the first: turning one on quietly turns the
-- other off, or a shared row means one failure marks both sent. Every
-- combination is exercised here against notify_raise itself, not against a
-- helper that stands in for it.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.chk(label text, ok boolean) returns void
language plpgsql as $$
begin
  if ok then raise notice 'PASS: %', label;
  else raise exception 'FAIL: %', label; end if;
end $$;

do $outer$
declare
  actor   jsonb := jsonb_build_object('id','u1','name','QA Admin','email','qa-admin@larsaeng.com','access','Super Admin');
  n       int;
  n2      int;
  txt     text;
  b       boolean;
  res     jsonb;
  items   jsonb;
begin
  -- ---------------------------------------------------------------- fixture
  -- The staff directory is a JSON blob, and notify_user_email digs the address
  -- out of it. Dave has one, Erin does not — that difference is load-bearing
  -- for the "no address" case below.
  insert into public.app_state (store_key, data) values (
    'larsaStaffV8',
    jsonb_build_object('users', jsonb_build_array(
      jsonb_build_object('id','zz-qa-dave','name','Dave QA','email','dave.qa@larsaeng.com','enabled',true),
      jsonb_build_object('id','zz-qa-erin','name','Erin QA','email','',                    'enabled',true),
      jsonb_build_object('id','zz-qa-gone','name','Gone QA','email','gone.qa@larsaeng.com','enabled',false)
    )))
  on conflict (store_key) do update set data = excluded.data;

  insert into public.notify_rules (event, label, description, category, mail_subject)
  values ('zz.qa.event', 'QA event', 'Fixture rule', 'system', 'QA subject')
  on conflict (event) do nothing;

  -- ============================================================ 1. defaults
  select mail_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('a new rule starts with email OFF', b = false);
  select push_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('and push ON, so nothing about today changes', b = true);

  select count(*) into n from public.notify_rules where mail_enabled;
  perform pg_temp.chk('no seeded rule enables email by itself', n = 0);

  -- =================================================== 2. push ON, mail OFF
  update public.notify_rules set push_enabled = true, mail_enabled = false where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','One','body','b','dedupeKey','k1')));

  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.user_uid = 'zz-qa-dave' and o.channel = 'push';
  perform pg_temp.chk('push ON queues a push row', n = 1);
  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.user_uid = 'zz-qa-dave' and o.channel = 'mail';
  perform pg_temp.chk('mail OFF queues no mail row', n = 0);

  -- =================================================== 3. push OFF, mail ON
  update public.notify_rules set push_enabled = false, mail_enabled = true where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Two','body','b','dedupeKey','k2')));

  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.dedupe_key = 'k2' and o.channel = 'mail';
  perform pg_temp.chk('mail ON queues a mail row', n = 1);
  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.dedupe_key = 'k2' and o.channel = 'push';
  perform pg_temp.chk('push OFF queues no push row', n = 0);
  select count(*) into n from public.notify_messages where dedupe_key = 'k2';
  perform pg_temp.chk('the bell still gets the message with push off', n = 1);

  -- ==================================================== 4. both ON = two rows
  update public.notify_rules set push_enabled = true, mail_enabled = true where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Three','body','b','dedupeKey','k3')));

  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k3';
  perform pg_temp.chk('both ON queues exactly two rows', n = 2);
  select count(distinct o.channel) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k3';
  perform pg_temp.chk('one per channel, not two of the same', n = 2);
  select count(distinct o.idem_key) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k3';
  perform pg_temp.chk('each channel carries its own idempotency key', n = 2);

  -- ================================================== 5. both OFF = bell only
  update public.notify_rules set push_enabled = false, mail_enabled = false where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Four','body','b','dedupeKey','k4')));

  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k4';
  perform pg_temp.chk('both OFF sends nothing outside the app', n = 0);
  select count(*) into n from public.notify_messages where dedupe_key = 'k4';
  perform pg_temp.chk('but the notification still reaches the bell', n = 1);

  -- ========================================= 6. one channel does not move the other
  update public.notify_rules set push_enabled = true, mail_enabled = false where event = 'zz.qa.event';
  perform public.notify_rules_set(actor, 'zz.qa.event', jsonb_build_object('mail', true));
  select push_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('turning email ON leaves push ON', b = true);
  select mail_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('and email really did turn on', b = true);

  perform public.notify_rules_set(actor, 'zz.qa.event', jsonb_build_object('push', false));
  select mail_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('turning push OFF leaves email ON', b = true);

  perform public.notify_rules_set(actor, 'zz.qa.event', jsonb_build_object('push', true));
  select mail_enabled into b from public.notify_rules where event = 'zz.qa.event';
  perform pg_temp.chk('turning push back ON leaves email untouched', b = true);

  -- ================================================ 7. an inactive rule is silent
  update public.notify_rules set push_enabled = true, mail_enabled = true, active = false where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Five','body','b','dedupeKey','k5')));
  select count(*) into n from public.notify_messages where dedupe_key = 'k5';
  perform pg_temp.chk('an inactive rule raises nothing at all', n = 0);
  update public.notify_rules set active = true where event = 'zz.qa.event';

  -- ====================================== 8. no address means no mail, not an error
  update public.notify_rules set push_enabled = true, mail_enabled = true where event = 'zz.qa.event';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-erin','event','zz.qa.event','title','Six','body','b','dedupeKey','k6')));
  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.dedupe_key = 'k6' and o.channel = 'mail';
  perform pg_temp.chk('somebody with no address gets no mail row', n = 0);
  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.dedupe_key = 'k6' and o.channel = 'push';
  perform pg_temp.chk('but still gets the push', n = 1);

  -- ================================ 9. the address comes from the record, not the caller
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Seven','body','b','dedupeKey','k7',
    -- A caller trying to redirect the mail somewhere of their choosing.
    'mailTo','attacker@example.com','email','attacker@example.com')));
  select o.mail_to into txt from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id
   where m.dedupe_key = 'k7' and o.channel = 'mail';
  perform pg_temp.chk('the mail goes to the address on the staff record', txt = 'dave.qa@larsaeng.com');
  perform pg_temp.chk('a caller-supplied address is ignored entirely', txt <> 'attacker@example.com');

  perform pg_temp.chk('a disabled account resolves to no address',
    public.notify_user_email('zz-qa-gone') is null);
  perform pg_temp.chk('an unknown id resolves to no address',
    public.notify_user_email('zz-qa-nobody') is null);

  -- ==================================== 10. reprocessing does not double-send
  -- Same dedupe key as k7: the message is deduped, so neither channel queues
  -- a second time. This is the "duplicate event processing" guarantee.
  select count(*) into n from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k7';
  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Seven again','body','b','dedupeKey','k7')));
  select count(*) into n2 from public.notify_outbox o
    join public.notify_messages m on m.id = o.notification_id where m.dedupe_key = 'k7';
  perform pg_temp.chk('replaying the same event queues no extra mail', n2 = n);

  -- ============================================= 11. claiming is per channel
  update public.notify_outbox set status = 'queued'
   where notification_id in (select id from public.notify_messages where dedupe_key = 'k3');

  res := public.notify_outbox_claim(200, 'mail');
  items := res->'items';
  select count(*) into n from jsonb_array_elements(items) i where i->>'channel' <> 'mail';
  perform pg_temp.chk('claiming mail returns only mail rows', n = 0);

  res := public.notify_outbox_claim(200, 'push');
  items := res->'items';
  select count(*) into n from jsonb_array_elements(items) i where i->>'channel' <> 'push';
  perform pg_temp.chk('claiming push returns only push rows', n = 0);
  select count(*) into n from jsonb_array_elements(items) i
   where jsonb_typeof(i->'devices') <> 'array';
  perform pg_temp.chk('push rows still carry their device list', n = 0);

  -- The default argument must still mean push, or send-push starts eating mail.
  res := public.notify_outbox_claim(1);
  select count(*) into n from jsonb_array_elements(res->'items') i where i->>'channel' <> 'push';
  perform pg_temp.chk('the one-argument call still means push only', n = 0);

  -- ============================== 12. a personal opt-out still suppresses mail
  insert into public.notify_prefs (user_uid, category, push_enabled, mail_enabled)
  values ('zz-qa-dave', 'system', true, false)
  on conflict (user_uid, category) do update set mail_enabled = false;

  perform public.notify_raise(actor, jsonb_build_array(jsonb_build_object(
    'userUid','zz-qa-dave','event','zz.qa.event','title','Eight','body','b','dedupeKey','k8')));
  update public.notify_outbox set status = 'queued'
   where notification_id in (select id from public.notify_messages where dedupe_key = 'k8');

  res := public.notify_outbox_claim(200, 'mail');
  select count(*) into n from jsonb_array_elements(res->'items') i
   where i->>'channel' = 'mail' and coalesce(i->>'suppressed','') = 'category-off';
  perform pg_temp.chk('an admin rule cannot override a personal mail opt-out', n >= 1);

  -- ============================================================ 13. the audit
  select count(*) into n from public.account_lifecycle_audit
   where action = 'notification.mail_toggled' and target_id = 'zz.qa.event';
  perform pg_temp.chk('turning email on is written to the audit log', n >= 1);
  select count(*) into n from public.account_lifecycle_audit
   where action = 'notification.push_toggled' and target_id = 'zz.qa.event';
  perform pg_temp.chk('so is turning push off', n >= 1);
  select count(*) into n from public.account_lifecycle_audit
   where target_id = 'zz.qa.event' and details::text ilike '%password%';
  perform pg_temp.chk('and the audit carries no secret', n = 0);

  -- ============================================================== 14. grants
  perform pg_temp.chk('anon cannot read the rule list',
    has_function_privilege('anon', 'public.notify_rules_list(jsonb)', 'EXECUTE') = false);
  perform pg_temp.chk('anon cannot change a rule',
    has_function_privilege('anon', 'public.notify_rules_set(jsonb, text, jsonb)', 'EXECUTE') = false);
  perform pg_temp.chk('anon cannot resolve an address',
    has_function_privilege('anon', 'public.notify_user_email(text)', 'EXECUTE') = false);
  perform pg_temp.chk('a signed-in session can read the rule list',
    has_function_privilege('authenticated', 'public.notify_rules_list(jsonb)', 'EXECUTE') = true);
  perform pg_temp.chk('only the service role may claim the outbox',
    has_function_privilege('authenticated', 'public.notify_outbox_claim(int, text)', 'EXECUTE') = false);
  perform pg_temp.chk('the rules table itself is not client-readable',
    has_table_privilege('authenticated', 'public.notify_rules', 'SELECT') = false);
end $outer$;

rollback;
