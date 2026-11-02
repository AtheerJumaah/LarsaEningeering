-- Company-managed attendance encouragement.
--
-- This runs in Postgres every fifteen minutes.  Nothing polls from the browser,
-- so reminders continue when the app is closed and cannot make the UI freeze.
-- A saved roster shift is authoritative.  When no shift is saved, a weekday is
-- considered expected only after the employee has repeatedly clocked in on that
-- weekday during the configured lookback window.  Friday and Saturday therefore
-- work naturally for the people who actually work them.

alter table public.auth_policy
  add column if not exists attendance_notifications jsonb not null default
  '{"enabled":false,"push_enabled":true,"email_enabled":true,"email_hourly":false,"milestone_interval_hours":1,"milestone_max_hours":9,"missing_clock_in":true,"missing_grace_minutes":90,"use_schedule":true,"use_work_pattern":true,"pattern_lookback_days":56,"pattern_min_days":2,"active_from_hour":7,"active_to_hour":21,"critical_shift_hours":12,"notify_manager_on_critical":true}'::jsonb;

alter table public.notify_rules
  add column if not exists company_managed boolean not null default false;

alter table public.notify_outbox
  add column if not exists company_managed boolean not null default false;

insert into public.notify_rules
  (event, label, description, category, trigger_text, recipients_text,
   push_enabled, mail_enabled, active, delay_minutes, message_template,
   mail_subject, company_managed, updated_at, updated_by)
values
  ('clock.encouragement', 'Time-on-shift encouragement',
   'A gentle progress note while an employee is clocked in.', 'attendance',
   'At company milestones while a shift is open', 'The clocked-in employee',
   true, true, true, 0, 'A short progress note based on time worked.',
   'Your workday progress', true, now(), 'system'),
  ('clock.missing', 'Expected clock-in',
   'A gentle note when a scheduled or well-established workday has not started.', 'attendance',
   'After the configured grace period', 'The employee expected to work',
   true, true, true, 0, 'We miss you today. Clock in if you are working.',
   'We miss you today', true, now(), 'system'),
  ('clock.long_shift', 'Long open shift',
   'A clock-out safety note after an unusually long open shift.', 'attendance',
   'After the company long-shift threshold', 'The clocked-in employee',
   true, true, true, 0, 'Your shift is still open. Clock out if you are finished.',
   'Your shift is still open', true, now(), 'system'),
  ('clock.review_hours', 'Long shift review',
   'A direct manager review note after a critical open shift.', 'attendance',
   'After the critical shift threshold', 'The employee direct manager',
   true, true, true, 0, 'Please review this unusually long open shift.',
   'Attendance review needed', true, now(), 'system')
on conflict (event) do update set
  label = excluded.label,
  description = excluded.description,
  category = excluded.category,
  trigger_text = excluded.trigger_text,
  recipients_text = excluded.recipients_text,
  push_enabled = excluded.push_enabled,
  mail_enabled = excluded.mail_enabled,
  active = excluded.active,
  delay_minutes = excluded.delay_minutes,
  message_template = excluded.message_template,
  mail_subject = excluded.mail_subject,
  company_managed = true,
  updated_at = now(),
  updated_by = 'system';

-- The settings screen must state which channel is company-managed.  A managed
-- category is shown but cannot be switched off by the employee.
create or replace function public.notify_setup(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor);
begin
  return jsonb_build_object(
    'ok', true,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'label', c.label, 'description', c.description,
        'sensitive', c.sensitive,
        'managed', exists (
          select 1 from public.notify_rules r
          where r.category = c.id and r.company_managed and r.active
        ),
        'push', case when exists (
          select 1 from public.notify_rules r
          where r.category = c.id and r.company_managed and r.active and r.push_enabled
        ) then true else coalesce(p.push_enabled, true) end,
        'mail', case when exists (
          select 1 from public.notify_rules r
          where r.category = c.id and r.company_managed and r.active and r.mail_enabled
        ) then true else coalesce(p.mail_enabled, false) end
      ) order by c.sort_order)
      from public.notify_categories c
      left join public.notify_prefs p on p.category = c.id and p.user_uid = uid
    ), '[]'::jsonb),
    'settings', coalesce((
      select jsonb_build_object(
        'quietFrom', s.quiet_from, 'quietTo', s.quiet_to,
        'badge', s.badge_enabled, 'sound', s.sound_enabled, 'tz', s.tz)
      from public.notify_settings s where s.user_uid = uid
    ), jsonb_build_object('quietFrom', null, 'quietTo', null,
                          'badge', true, 'sound', true, 'tz', 'Asia/Baghdad')),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', coalesce(d.device_label, 'Unnamed device'),
        'platform', d.platform, 'enabled', d.enabled,
        'lastSeen', d.last_seen_at, 'createdAt', d.created_at
      ) order by d.last_seen_at desc)
      from public.push_subscriptions d where d.staff_uid = uid
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.notify_set_pref(
  actor jsonb, p_category text, p_push boolean, p_mail boolean)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor);
begin
  if not exists (select 1 from public.notify_categories where id = p_category) then
    raise exception 'NOTIFY_PREF: unknown category %', p_category;
  end if;
  if exists (select 1 from public.notify_rules r
             where r.category = p_category and r.company_managed and r.active) then
    return jsonb_build_object('ok', false, 'managed', true);
  end if;
  insert into public.notify_prefs (user_uid, category, push_enabled, mail_enabled, updated_at)
  values (uid, p_category, coalesce(p_push, true), coalesce(p_mail, false), now())
  on conflict (user_uid, category) do update
    set push_enabled = excluded.push_enabled,
        mail_enabled = excluded.mail_enabled,
        updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- Company-managed outbox rows bypass employee category switches and personal
-- quiet hours.  The attendance sweep itself applies the company's local active
-- window before creating them, so no device is interrupted during the night.
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
    'id', o.id, 'notificationId', o.notification_id,
    'userUid', o.user_uid, 'category', o.category,
    'title', o.title, 'body', o.body, 'url', o.url,
    'attempts', o.attempts, 'channel', o.channel, 'mailTo', o.mail_to,
    'suppressed', case
        when o.company_managed then null
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

-- Insert one permanent bell record and its external deliveries.  The unique
-- message key makes every cron run idempotent.
create or replace function public.attendance_notify_one(
  p_uid text, p_event text, p_title text, p_body text, p_dedupe text,
  p_push boolean, p_mail boolean, p_item_id text default 'quick-clock')
returns boolean
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare msg_id uuid; addr text;
begin
  insert into public.notify_messages
    (user_uid, event, category, title, body, item_id, actor_name, dedupe_key, meta)
  values
    (p_uid, p_event, 'attendance', left(p_title, 200), left(p_body, 2000),
     p_item_id, 'Larsa Control', p_dedupe,
     jsonb_build_object('companyManaged', true, 'attendanceEncouragement', true))
  on conflict (user_uid, dedupe_key) where dedupe_key is not null do nothing
  returning id into msg_id;

  if msg_id is null then return false; end if;

  if p_push then
    insert into public.notify_outbox
      (idem_key, notification_id, user_uid, category, title, body, url, channel, company_managed)
    values
      ('msg:' || msg_id::text, msg_id, p_uid, 'attendance', left(p_title, 200),
       left(p_body, 2000), '/?n=' || msg_id::text, 'push', true)
    on conflict (idem_key) do nothing;
  end if;

  if p_mail then
    addr := public.notify_user_email(p_uid);
    if addr is not null then
      insert into public.notify_outbox
        (idem_key, notification_id, user_uid, category, title, body, url, channel, mail_to, company_managed)
      values
        ('mail:' || msg_id::text, msg_id, p_uid, 'attendance', left(p_title, 200),
         left(p_body, 2000), '/?n=' || msg_id::text, 'mail', addr, true)
      on conflict (idem_key) do nothing;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function public.attendance_notify_one(text,text,text,text,text,boolean,boolean,text)
  from public, anon, authenticated;

create or replace function public.attendance_notification_sweep()
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $fn$
declare
  cfg jsonb;
  store jsonb;
  person jsonb;
  uid text;
  employee_name text;
  manager_ref text;
  manager_uid text;
  tz text;
  local_now timestamp;
  local_day date;
  day_name text;
  minute_now int;
  active_from int;
  active_to int;
  interval_hours int;
  max_hours int;
  critical_hours int;
  elapsed_hours numeric;
  milestone int;
  last_status text;
  shift_started timestamptz;
  expected_start int;
  scheduled boolean;
  pattern_count int;
  pattern_start numeric;
  already_in_today boolean;
  made int := 0;
  checked int := 0;
  body_text text;
begin
  select attendance_notifications into cfg from public.auth_policy where id = 1;
  cfg := coalesce(cfg, '{}'::jsonb);
  if not coalesce((cfg->>'enabled')::boolean, true) then
    return jsonb_build_object('ok', true, 'disabled', true, 'created', 0);
  end if;

  select data into store from public.app_state where store_key = 'larsaStaffV8';
  if store is null then return jsonb_build_object('ok', false, 'error', 'staff store unavailable'); end if;

  active_from := least(23, greatest(0, coalesce((cfg->>'active_from_hour')::int, 7)));
  active_to := least(24, greatest(1, coalesce((cfg->>'active_to_hour')::int, 21)));
  interval_hours := least(8, greatest(1, coalesce((cfg->>'milestone_interval_hours')::int, 1)));
  max_hours := least(16, greatest(interval_hours, coalesce((cfg->>'milestone_max_hours')::int, 9)));
  critical_hours := least(24, greatest(max_hours, coalesce((cfg->>'critical_shift_hours')::int, 12)));

  for person in select value from jsonb_array_elements(coalesce(store->'users', '[]'::jsonb)) loop
    if coalesce(person->>'enabled', 'true') = 'false' or coalesce(person->>'offboarded', 'false') = 'true' then continue; end if;
    uid := nullif(trim(person->>'id'), '');
    if uid is null then continue; end if;
    checked := checked + 1;
    employee_name := coalesce(nullif(trim(person->>'name'), ''), 'there');

    select s.tz into tz from public.notify_settings s where s.user_uid = uid;
    if tz is null or tz = '' then
      tz := case when lower(coalesce(person->>'location','')) ~ '(us|usa|chicago|central)'
                 then 'America/Chicago' else 'Asia/Baghdad' end;
    end if;
    begin
      local_now := clock_timestamp() at time zone tz;
    exception when invalid_parameter_value then
      tz := 'Asia/Baghdad';
      local_now := clock_timestamp() at time zone tz;
    end;
    local_day := local_now::date;
    day_name := to_char(local_now, 'FMDay');
    minute_now := extract(hour from local_now)::int * 60 + extract(minute from local_now)::int;
    if extract(hour from local_now)::int < active_from or extract(hour from local_now)::int >= active_to then continue; end if;

    -- Current shift state is read from the corrected attendance view.
    select e.status into last_status
    from public.attendance_effective_events(uid) e
    order by e.occurred_at desc limit 1;

    shift_started := null;
    if coalesce(last_status, 'Out') <> 'Out' then
      select max(e.occurred_at) into shift_started
      from public.attendance_effective_events(uid) e
      where e.status = 'In';
    end if;

    -- A legacy or recovered record can be left open for weeks.  It belongs in
    -- the existing hours-review workflow, not in today's encouragement loop.
    -- Treat only a plausibly current shift as live so a deployment never sends
    -- somebody a "12-hour shift" alert about an old incident.
    if shift_started < clock_timestamp() - interval '36 hours' then
      shift_started := null;
    end if;

    if shift_started is not null then
      elapsed_hours := extract(epoch from (clock_timestamp() - shift_started)) / 3600.0;
      milestone := floor(elapsed_hours / interval_hours)::int * interval_hours;
      milestone := least(milestone, max_hours);
      if milestone >= interval_hours then
        body_text := case
          when milestone = 1 then 'You have been clocked in for one hour. Good start, ' || split_part(employee_name, ' ', 1) || '.'
          when milestone >= 9 then milestone || ' hours are recorded today—great work. If you are finished, remember to clock out.'
          else 'You have been clocked in for ' || milestone || ' hours. Nice progress—keep a steady pace.'
        end;
        if public.attendance_notify_one(
          uid, 'clock.encouragement',
          case when milestone >= 9 then 'Great work today' else milestone || '-hour progress' end,
          body_text,
          'attendance:milestone:' || uid || ':' || shift_started::text || ':' || milestone,
          coalesce((cfg->>'push_enabled')::boolean, true),
          coalesce((cfg->>'email_enabled')::boolean, true)
            and (coalesce((cfg->>'email_hourly')::boolean, false) or milestone >= 9)
        ) then made := made + 1; end if;
      end if;

      if elapsed_hours >= critical_hours then
        if public.attendance_notify_one(
          uid, 'clock.long_shift', 'Your shift is still open',
          'You have been clocked in for more than ' || critical_hours || ' hours. If you are finished, please clock out; otherwise your time remains safely recorded.',
          'attendance:critical:' || uid || ':' || shift_started::text,
          coalesce((cfg->>'push_enabled')::boolean, true),
          coalesce((cfg->>'email_enabled')::boolean, true)
        ) then made := made + 1; end if;

        if coalesce((cfg->>'notify_manager_on_critical')::boolean, true) then
          manager_ref := nullif(trim(person->>'manager'), '');
          if manager_ref is not null then
            select u->>'id' into manager_uid
            from jsonb_array_elements(coalesce(store->'users','[]'::jsonb)) u
            where u->>'id' = manager_ref or lower(u->>'name') = lower(manager_ref)
            limit 1;
            if manager_uid is not null and public.attendance_notify_one(
              manager_uid, 'clock.review_hours', 'Attendance review needed',
              employee_name || ' has an open shift longer than ' || critical_hours || ' hours. Please review it when practical.',
              'attendance:manager-critical:' || uid || ':' || shift_started::text,
              coalesce((cfg->>'push_enabled')::boolean, true),
              coalesce((cfg->>'email_enabled')::boolean, true),
              'staff-timesheet'
            ) then made := made + 1; end if;
          end if;
        end if;
      end if;
      continue;
    end if;

    if not coalesce((cfg->>'missing_clock_in')::boolean, true) then continue; end if;
    expected_start := null;
    scheduled := false;

    if coalesce((cfg->>'use_schedule')::boolean, true)
       and jsonb_typeof(store->'schedule'->uid->day_name) = 'array'
       and jsonb_array_length(store->'schedule'->uid->day_name) > 0 then
      begin
        expected_start := split_part((store->'schedule'->uid->day_name->0->>'start'), ':', 1)::int * 60
                        + split_part((store->'schedule'->uid->day_name->0->>'start'), ':', 2)::int;
        scheduled := true;
      exception when others then
        expected_start := null;
      end;
    end if;

    if expected_start is null and coalesce((cfg->>'use_work_pattern')::boolean, true) then
      select count(*), avg(start_min) into pattern_count, pattern_start
      from (
        select (e.occurred_at at time zone tz)::date as work_date,
               min(extract(hour from (e.occurred_at at time zone tz))::int * 60
                 + extract(minute from (e.occurred_at at time zone tz))::int) as start_min
        from public.attendance_effective_events(uid) e
        where e.status = 'In'
          and (e.occurred_at at time zone tz)::date < local_day
          and (e.occurred_at at time zone tz)::date >= local_day - least(120, greatest(14, coalesce((cfg->>'pattern_lookback_days')::int, 56)))
          and extract(dow from (e.occurred_at at time zone tz)) = extract(dow from local_now)
        group by (e.occurred_at at time zone tz)::date
      ) history;
      if pattern_count >= least(8, greatest(2, coalesce((cfg->>'pattern_min_days')::int, 2))) then
        expected_start := round(pattern_start)::int;
      end if;
    end if;

    if expected_start is null then continue; end if;
    if minute_now < expected_start + least(360, greatest(15, coalesce((cfg->>'missing_grace_minutes')::int, 90))) then continue; end if;

    select exists (
      select 1 from public.attendance_effective_events(uid) e
      where e.status = 'In' and (e.occurred_at at time zone tz)::date = local_day
    ) into already_in_today;
    if already_in_today then continue; end if;

    body_text := case when scheduled
      then 'Your scheduled workday has not started in Larsa Control. If you are working, please clock in.'
      else 'You usually work on ' || day_name || 's. If you are working today, open Larsa Control and clock in—we miss you.'
    end;
    if public.attendance_notify_one(
      uid, 'clock.missing', 'We miss you today', body_text,
      'attendance:missing:' || uid || ':' || local_day::text,
      coalesce((cfg->>'push_enabled')::boolean, true),
      coalesce((cfg->>'email_enabled')::boolean, true)
    ) then made := made + 1; end if;
  end loop;

  if made > 0 then perform public.notify_dispatch(); end if;
  return jsonb_build_object('ok', true, 'checked', checked, 'created', made, 'at', clock_timestamp());
end;
$fn$;

revoke all on function public.attendance_notification_sweep() from public, anon, authenticated;
grant execute on function public.attendance_notification_sweep() to service_role;

do $$
begin
  perform cron.unschedule('attendance-notification-sweep');
exception when others then null;
end $$;

select cron.schedule(
  'attendance-notification-sweep',
  '*/15 * * * *',
  'select public.attendance_notification_sweep();'
);

