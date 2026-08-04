-- ============================================================================
-- EMAIL IS A SECOND CHANNEL, NOT A SETTING ON THE FIRST
--
-- Push already works end to end: notify_raise queues an outbox row, pg_net
-- hands it to send-push, send-push records what happened in notify_deliveries.
-- The schema has always had room for a second channel — notify_prefs carries a
-- mail_enabled column and notify_deliveries.channel already accepts 'mail' —
-- but nothing ever wrote either, so mail was a column with no code behind it.
--
-- This adds the code, and keeps the two channels genuinely independent:
--
--   * The outbox grows a `channel` column. A message that should go both ways
--     produces TWO rows, one per channel, each with its own idem_key, its own
--     status and its own retry count. One channel failing cannot mark the
--     other sent, and re-processing the same event cannot double-send either,
--     because idem_key stays unique.
--
--   * notify_rules is the admin-level answer to "does this KIND of event use
--     email at all". notify_prefs stays the per-person answer to "do I want
--     mail for this category". Both must say yes. An admin turning email on
--     for a rule does not override somebody's personal preference, and a
--     person turning mail on for a category does not start mail for rules the
--     company has left push-only.
--
--   * Every rule ships with mail_enabled = false. Nothing starts emailing
--     because this migration ran. Existing push behaviour is byte-identical:
--     a rule row that does not exist means "push, no mail", which is exactly
--     what every event does today.
--
-- The recipient's address is resolved HERE, from the staff record, not taken
-- from whatever the caller passed in. A client that can raise a notification
-- must not also get to choose where the email lands.
-- ============================================================================

-- ---------------------------------------------------------------- 1. channel
alter table public.notify_outbox
  add column if not exists channel text not null default 'push';

do $blk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.notify_outbox'::regclass
       and conname  = 'notify_outbox_channel_ck'
  ) then
    alter table public.notify_outbox
      add constraint notify_outbox_channel_ck check (channel in ('push','mail'));
  end if;
end $blk$;

-- Claiming is per-channel, so the two senders never see each other's work.
create index if not exists notify_outbox_channel_idx
  on public.notify_outbox (channel, status, created_at);

-- Mail rows carry the resolved destination. Push rows leave it null — their
-- destination is the device list, which is resolved at claim time because
-- devices come and go between queueing and sending.
alter table public.notify_outbox
  add column if not exists mail_to text;

-- ------------------------------------------------------------------ 2. rules
create table if not exists public.notify_rules (
  event            text primary key,
  label            text not null,
  description      text not null default '',
  category         text not null references public.notify_categories(id),
  trigger_text     text not null default '',
  recipients_text  text not null default '',
  -- The two channels, independently. Neither derives from the other.
  push_enabled     boolean not null default true,
  mail_enabled     boolean not null default false,
  active           boolean not null default true,
  delay_minutes    int not null default 0 check (delay_minutes between 0 and 10080),
  message_template text not null default '',
  mail_subject     text not null default '',
  updated_at       timestamptz not null default now(),
  updated_by       text
);

comment on table public.notify_rules is
  'Admin-level configuration per notification event. Answers "does this kind of '
  'event use push, email, both or neither". Per-person opt-outs live in '
  'notify_prefs and are ANDed with this — both must allow a channel.';

alter table public.notify_rules enable row level security;
revoke all on public.notify_rules from anon, authenticated;

-- Seeded from the events the app actually raises, plus those declared in
-- NOTIFY_EVENTS. push_enabled true preserves exactly today's behaviour;
-- mail_enabled false means this migration sends no email by itself.
insert into public.notify_rules (event, label, description, category, trigger_text, recipients_text, mail_subject) values
  ('leave.requested',       'Leave requested',        'Somebody submitted a leave or change request.',        'leave',       'Request submitted',            'Request approvers',      'Leave request awaiting your approval'),
  ('leave.decided',         'Request decided',        'A leave or change request was approved or rejected.',  'leave',       'Final decision recorded',      'Requester',              'Your request has been decided'),
  ('clock.correction',      'Attendance correction',  'An attendance correction was submitted.',              'attendance',  'Correction submitted',         'Request approvers',      'Attendance correction awaiting approval'),
  ('clock.byManager',       'Clocked by a manager',   'A manager clocked someone in or out on their behalf.', 'attendance',  'Manager clock action',         'Affected employee',      'Your attendance was updated'),
  ('schedule.changed',      'Schedule rebuilt',       'The weekly schedule was rebuilt.',                     'schedule',    'Auto Build run',               'All rostered staff',     'This week''s schedule has changed'),
  ('points.submitted',      'Points submitted',       'An employee submitted points for review.',             'performance', 'Points submitted',             'Reviewer',               'Points awaiting your review'),
  ('points.reviewed',       'Points reviewed',        'Submitted points were approved or returned.',          'performance', 'Review completed',             'Employee',               'Your points have been reviewed'),
  ('points.week',           'Week locked or reopened','A performance week was locked or reopened.',           'performance', 'Week lock changed',            'Affected employees',     'Performance week updated'),
  ('points.unlock',         'Late entry requested',   'Somebody asked to add points to a closed week.',       'performance', 'Late entry requested',         'Request approvers',      'Late points entry awaiting approval'),
  ('development.assigned',  'Development assigned',   'A development activity was assigned.',                 'development', 'Activity assigned',            'Assigned employee',      'A development activity was assigned to you'),
  ('development.reviewed',  'Development reviewed',   'A development submission was reviewed.',               'development', 'Submission reviewed',          'Employee',               'Your development submission was reviewed'),
  ('project.updated',       'Project updated',        'A project record changed.',                            'projects',    'Project record changed',       'Project members',        'A project you work on was updated'),
  ('accounting.entry',      'Accounting entry',       'An accounting entry was recorded.',                    'accounting',  'Entry posted',                 'Accountant',             'A new accounting entry was recorded'),
  ('accounting.flag',       'Accounting flag',        'An accounting entry was flagged for review.',          'accounting',  'Entry flagged',                'Accountant + Admin',     'An accounting entry needs review'),
  ('pay.published',         'Payslip published',      'A payslip became available.',                          'pay',         'Payroll published',            'Employee',               'Your payslip is available'),
  ('pay.paid',              'Payment recorded',       'A payroll payment was recorded.',                      'pay',         'Payment recorded',             'Employee',               'A payment has been recorded'),
  ('pay.commission',        'Commission updated',     'A commission was approved or changed.',                'pay',         'Commission decided',           'Employee',               'Your commission was updated'),
  ('admin.broadcast',       'Administration message', 'A message sent by an administrator.',                  'announcements','Admin sends a message',       'Chosen group',           'A message from Larsa Engineering')
on conflict (event) do nothing;

-- ------------------------------------------------- 3. resolving the address
-- The staff directory is a JSON blob rather than a table (app_state holds it
-- under larsaStaffV8), so the address is dug out of there. Doing it in SQL
-- rather than accepting it from the caller is the point: notify_raise is
-- callable by any signed-in client, and an address chosen by the caller would
-- let one person have another person's notification mailed to them.
create or replace function public.notify_user_email(p_uid text)
returns text
language sql
stable
security definer set search_path = public, pg_temp
as $$
  select nullif(trim(u->>'email'), '')
    from public.app_state s,
         lateral jsonb_array_elements(s.data->'users') u
   where s.store_key = 'larsaStaffV8'
     and u->>'id' = p_uid
     and coalesce(u->>'enabled', 'true') <> 'false'
   limit 1
$$;

revoke all on function public.notify_user_email(text) from public, anon;
grant execute on function public.notify_user_email(text) to authenticated, service_role;

-- ------------------------------------------------------------ 4. notify_raise
-- Same contract, same return shape. What changes is that one message can now
-- produce up to two outbox rows, and that an inactive rule produces none.
create or replace function public.notify_raise(actor jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, extensions, pg_temp
as $fn$
declare
  a_name   text := coalesce(nullif(trim(actor->>'name'),''), 'Larsa Control');
  row_in   jsonb;
  msg_id   uuid;
  made     int := 0;
  skipped  int := 0;
  queued   int := 0;
  cat      text;
  ev       text;
  rule     public.notify_rules%rowtype;
  want_push boolean;
  want_mail boolean;
  addr     text;
begin
  perform public.notify_actor_uid(actor);
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'NOTIFY_RAISE: p_rows must be an array';
  end if;

  for row_in in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(row_in->>'userUid'),'') = '' or coalesce(trim(row_in->>'title'),'') = '' then
      continue;
    end if;
    ev  := coalesce(nullif(trim(row_in->>'event'),''), 'system');
    cat := public.notify_event_category(ev);

    select * into rule from public.notify_rules where event = ev;

    -- An event with no rule row behaves exactly as it did before this
    -- migration: it goes to the bell and it pushes. Only an explicitly
    -- configured rule can change that.
    if found and not rule.active then
      -- Deactivated by an admin: no bell row, no outbox row, nothing.
      skipped := skipped + 1;
      continue;
    end if;
    want_push := (not found) or rule.push_enabled;
    want_mail := found and rule.mail_enabled;

    msg_id := null;
    insert into public.notify_messages
      (user_uid, event, category, title, body, item_id, actor_name, dedupe_key, meta)
    values (
      trim(row_in->>'userUid'),
      ev,
      cat,
      left(trim(row_in->>'title'), 200),
      left(coalesce(row_in->>'body',''), 2000),
      nullif(trim(coalesce(row_in->>'itemId','')), ''),
      a_name,
      nullif(trim(coalesce(row_in->>'dedupeKey','')), ''),
      coalesce(row_in->'meta', '{}'::jsonb)
    )
    on conflict (user_uid, dedupe_key) where dedupe_key is not null do nothing
    returning id into msg_id;

    if msg_id is null then
      skipped := skipped + 1;
      continue;
    end if;
    made := made + 1;

    -- Push. idem_key keeps the historic 'msg:<id>' shape so nothing already
    -- in flight is orphaned by the new naming.
    if want_push then
      insert into public.notify_outbox
        (idem_key, notification_id, user_uid, category, title, body, url, channel)
      values (
        'msg:' || msg_id::text,
        msg_id,
        trim(row_in->>'userUid'),
        cat,
        left(trim(row_in->>'title'), 200),
        public.notify_push_body(cat, row_in->>'body'),
        '/?n=' || msg_id::text,
        'push'
      )
      on conflict (idem_key) do nothing;
      queued := queued + 1;
    end if;

    -- Mail. Queued only when the rule allows it AND the person has an address
    -- on file. No address is not an error — it just means this person is
    -- reachable by push and the bell, which is the case for most of the
    -- directory today.
    if want_mail then
      addr := public.notify_user_email(trim(row_in->>'userUid'));
      if addr is not null then
        insert into public.notify_outbox
          (idem_key, notification_id, user_uid, category, title, body, url, channel, mail_to)
        values (
          'mail:' || msg_id::text,
          msg_id,
          trim(row_in->>'userUid'),
          cat,
          left(trim(row_in->>'title'), 200),
          -- Mail is not a lock screen, so the full body is kept even for
          -- sensitive categories. What keeps figures safe here is that the
          -- address was resolved from the staff record, so the mail can only
          -- reach the person the notification was already addressed to.
          left(coalesce(row_in->>'body',''), 2000),
          '/?n=' || msg_id::text,
          'mail',
          addr
        )
        on conflict (idem_key) do nothing;
        queued := queued + 1;
      end if;
    end if;
  end loop;

  if queued > 0 then perform public.notify_dispatch(); end if;

  return jsonb_build_object('ok', true, 'created', made, 'deduped', skipped);
end;
$fn$;

revoke all on function public.notify_raise(jsonb, jsonb) from public;
grant execute on function public.notify_raise(jsonb, jsonb) to anon, authenticated, service_role;

-- --------------------------------------------------------- 5. claiming, both
-- send-push calls this with one argument. Defaulting p_channel to 'push' keeps
-- that call meaning exactly what it always did, and stops the push sender ever
-- picking up a mail row.
--
-- The single-argument version has to GO, not just be replaced: adding a second
-- parameter creates an overload rather than replacing anything, and then
-- notify_outbox_claim(50) matches both signatures and Postgres refuses to pick.
-- send-push's existing one-argument call then fails outright. Dropping the old
-- one first leaves exactly one candidate, and that call keeps working.
drop function if exists public.notify_outbox_claim(int);

create or replace function public.notify_outbox_claim(p_limit int default 50, p_channel text default 'push')
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare claimed uuid[]; out_rows jsonb; chan text := coalesce(p_channel, 'push');
begin
  with picked as (
    select o.id
    from public.notify_outbox o
    where o.channel = chan
      and (o.status = 'queued'
        or (o.status = 'sending' and o.claimed_at < now() - interval '5 minutes'))
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  ), bumped as (
    update public.notify_outbox o
       set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
      from picked
     where o.id = picked.id
     returning o.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into claimed from bumped;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id,
    'notificationId', o.notification_id,
    'userUid', o.user_uid,
    'category', o.category,
    'title', o.title,
    'body', o.body,
    'url', o.url,
    'attempts', o.attempts,
    'channel', o.channel,
    'mailTo', o.mail_to,
    -- Suppression is resolved per channel: push obeys push_enabled and quiet
    -- hours, mail obeys mail_enabled only. Holding an email back until 07:00
    -- would help nobody — it does not light up a phone at 3am.
    'suppressed', case
        when o.channel = 'push' and not coalesce(p.push_enabled, true) then 'category-off'
        when o.channel = 'push' and public.notify_in_quiet_hours(s.quiet_from, s.quiet_to, s.tz) then 'quiet-hours'
        when o.channel = 'mail' and not coalesce(p.mail_enabled, false) then 'category-off'
        when o.channel = 'mail' and coalesce(o.mail_to, '') = '' then 'no address'
        else null end,
    'devices', case when o.channel <> 'push' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth))
      from public.push_subscriptions d
      where d.staff_uid = o.user_uid and d.enabled
    ), '[]'::jsonb) end
  )), '[]'::jsonb) into out_rows
  from public.notify_outbox o
  left join public.notify_prefs p on p.user_uid = o.user_uid and p.category = o.category
  left join public.notify_settings s on s.user_uid = o.user_uid
  where o.id = any(claimed);

  return jsonb_build_object('ok', true, 'items', out_rows);
end;
$$;

revoke all on function public.notify_outbox_claim(int, text) from public, anon, authenticated;
grant execute on function public.notify_outbox_claim(int, text) to service_role;

-- --------------------------------------------------------- 6. admin plumbing
-- Reading the rule list for the Notification Setup screen. Returns both
-- channel states per rule so the list can show them without opening each one.
create or replace function public.notify_rules_list(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare rows_out jsonb;
begin
  perform public.notify_actor_uid(actor);
  select coalesce(jsonb_agg(jsonb_build_object(
    'event', r.event, 'label', r.label, 'description', r.description,
    'category', r.category, 'trigger', r.trigger_text, 'recipients', r.recipients_text,
    'push', r.push_enabled, 'mail', r.mail_enabled, 'active', r.active,
    'delayMinutes', r.delay_minutes, 'template', r.message_template,
    'mailSubject', r.mail_subject, 'updatedAt', r.updated_at, 'updatedBy', r.updated_by
  ) order by r.category, r.label), '[]'::jsonb) into rows_out
  from public.notify_rules r;
  return jsonb_build_object('ok', true, 'rules', rows_out);
end;
$$;

revoke all on function public.notify_rules_list(jsonb) from public, anon;
grant execute on function public.notify_rules_list(jsonb) to authenticated, service_role;

-- Writing one. Every change is audited through the existing account audit
-- trail, which already refuses to store anything secret.
create or replace function public.notify_rules_set(actor jsonb, p_event text, p_patch jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  uid    text;
  before public.notify_rules%rowtype;
  after_ public.notify_rules%rowtype;
begin
  uid := public.notify_actor_uid(actor);

  select * into before from public.notify_rules where event = p_event;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such notification rule.');
  end if;

  update public.notify_rules set
    push_enabled     = coalesce((p_patch->>'push')::boolean,   push_enabled),
    mail_enabled     = coalesce((p_patch->>'mail')::boolean,   mail_enabled),
    active           = coalesce((p_patch->>'active')::boolean, active),
    delay_minutes    = coalesce((p_patch->>'delayMinutes')::int, delay_minutes),
    message_template = coalesce(p_patch->>'template',    message_template),
    mail_subject     = coalesce(p_patch->>'mailSubject', mail_subject),
    recipients_text  = coalesce(p_patch->>'recipients',  recipients_text),
    updated_at       = now(),
    updated_by       = coalesce(nullif(trim(actor->>'name'),''), uid)
  where event = p_event
  returning * into after_;

  -- One audit line per channel actually changed, so the trail reads as
  -- "who turned email on for this", not "who saved this form".
  if before.push_enabled is distinct from after_.push_enabled then
    perform public.account_audit_log(actor, 'notification.push_toggled', 'notification_rule',
      p_event, after_.label, jsonb_build_object('from', before.push_enabled, 'to', after_.push_enabled));
  end if;
  if before.mail_enabled is distinct from after_.mail_enabled then
    perform public.account_audit_log(actor, 'notification.mail_toggled', 'notification_rule',
      p_event, after_.label, jsonb_build_object('from', before.mail_enabled, 'to', after_.mail_enabled));
  end if;
  if before.active is distinct from after_.active then
    perform public.account_audit_log(actor, 'notification.rule_changed', 'notification_rule',
      p_event, after_.label, jsonb_build_object('active', after_.active));
  end if;

  return jsonb_build_object('ok', true, 'rule', jsonb_build_object(
    'event', after_.event, 'push', after_.push_enabled, 'mail', after_.mail_enabled,
    'active', after_.active, 'updatedAt', after_.updated_at, 'updatedBy', after_.updated_by));
end;
$$;

revoke all on function public.notify_rules_set(jsonb, text, jsonb) from public, anon;
grant execute on function public.notify_rules_set(jsonb, text, jsonb) to authenticated, service_role;

-- ------------------------------------------------------------- 7. dispatch
-- The mail sender is a second endpoint, so the dispatcher needs to reach both.
-- Absent secret = no-op, same as the push side: the bell keeps working and
-- only external delivery stops.
do $blk$
begin
  if not exists (select 1 from vault.secrets where name = 'notify_send_mail_url') then
    perform vault.create_secret(
      'https://fqxknodpkjdmueevafdk.supabase.co/functions/v1/notify-mail',
      'notify_send_mail_url',
      'Endpoint the notification outbox dispatcher calls for email');
  end if;
end $blk$;

create or replace function public.notify_dispatch()
returns void
language plpgsql
security definer set search_path = public, extensions, pg_temp
as $fn$
declare u text; m text; k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'notify_send_push_key';
  if k is null then return; end if;

  select decrypted_secret into u from vault.decrypted_secrets where name = 'notify_send_push_url';
  select decrypted_secret into m from vault.decrypted_secrets where name = 'notify_send_mail_url';

  if u is not null and exists (select 1 from public.notify_outbox
                                where channel = 'push' and status in ('queued','sending')) then
    perform net.http_post(
      url     := u,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
      body    := jsonb_build_object('limit', 100),
      timeout_milliseconds := 20000);
  end if;

  if m is not null and exists (select 1 from public.notify_outbox
                                where channel = 'mail' and status in ('queued','sending')) then
    perform net.http_post(
      url     := m,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
      body    := jsonb_build_object('limit', 100),
      timeout_milliseconds := 20000);
  end if;
exception when others then
  null;
end;
$fn$;

revoke all on function public.notify_dispatch() from public, anon, authenticated;
grant execute on function public.notify_dispatch() to service_role;
