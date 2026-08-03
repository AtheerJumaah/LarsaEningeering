-- ============================================================================
-- NOTIFICATION CENTRE — the authoritative record
--
-- Before this migration a notification existed in exactly one place: the
-- localStorage key "larsaNotificationsV1" on whichever device happened to be
-- open when it was raised. Sign in on your phone and the notification your
-- laptop received simply did not exist. Clear your browser data and the
-- record was gone. That is not a notification system, it is a toast that
-- outlives the page.
--
-- Here the bell becomes authoritative and permanent. Every notification is a
-- row in notify_messages, owned by its recipient, readable from any device.
-- External delivery (push, email) is a SEPARATE, OPTIONAL layer stacked on
-- top: notify_prefs can silence a push, and can never silence the bell. The
-- insert into notify_messages is unconditional — there is deliberately no
-- preference, no column, and no RPC argument anywhere in this file that can
-- prevent an in-app record from being written or remove it from the feed.
-- Archiving hides a row from the default view; it never deletes it.
--
-- AUTHORISATION MODEL. This app identifies staff by its own ids, not by
-- Supabase Auth, so auth.uid() is not available to write an RLS policy
-- against. Every table below therefore follows the same shape the accounting
-- layer established: RLS on, ALL grants revoked from anon and authenticated,
-- and every access path a SECURITY DEFINER function that filters by the
-- actor's id. The actor is self-asserted by the client, which is the same
-- residual risk already accepted and documented for acct_* and pay_*. What
-- it does buy, and what the old push_subscriptions policy (USING true) did
-- not, is that no client can read another person's rows by simply asking the
-- REST endpoint for the whole table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CATEGORIES
-- A notification's event is fine-grained ("points.reviewed"); a person's
-- patience is not. Preferences are expressed against twelve categories, so
-- the settings screen is twelve switches rather than a wall of them, and a
-- new event added later inherits a category the person has already answered
-- for instead of arriving switched-on and unasked.
-- ---------------------------------------------------------------------------
create table if not exists public.notify_categories (
  id          text primary key,
  label       text not null,
  description text not null,
  -- A "sensitive" category never puts its body text on a lock screen. See
  -- notify_push_body(): the amount stays behind the tap, in the record.
  sensitive   boolean not null default false,
  sort_order  int not null default 0
);

insert into public.notify_categories (id, label, description, sensitive, sort_order) values
  ('attendance',    'Attendance',        'Clock corrections and missed punches',            false,  1),
  ('schedule',      'Schedule',          'Shift changes and rebuilt weeks',                 false,  2),
  ('leave',         'Leave & requests',  'Leave requests and the decisions on them',        false,  3),
  ('performance',   'Performance',       'Points submitted, reviewed, and weeks closed',    false,  4),
  ('development',   'Development',       'Learning activities assigned and reviewed',       false,  5),
  ('projects',      'Projects',          'Progress and status on projects you can see',     false,  6),
  ('accounting',    'Accounting',        'Funding, expenses, invoices, and review flags',   true,   7),
  ('pay',           'Pay',               'Payslips, payments, and commissions',             true,   8),
  ('approvals',     'Approvals',         'Items waiting on your decision',                  false,  9),
  ('messages',      'Project messages',  'Messages in a project room you belong to',        false, 10),
  ('announcements', 'Announcements',     'Messages sent to you from Administration',        false, 11),
  ('system',        'Account & security','Sign-in, devices, and account changes',           false, 12)
on conflict (id) do update set
  label = excluded.label, description = excluded.description,
  sensitive = excluded.sensitive, sort_order = excluded.sort_order;

-- The map from the app's event ids to those twelve. Kept in the database
-- rather than only in the client so the push sender, which never loads the
-- client bundle, resolves a category the same way the settings screen does.
create or replace function public.notify_event_category(p_event text)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_event like 'clock.%'       then 'attendance'
    when p_event like 'schedule.%'    then 'schedule'
    when p_event like 'leave.%'       then 'leave'
    when p_event like 'points.%'      then 'performance'
    when p_event like 'development.%' then 'development'
    when p_event like 'project.updated' then 'projects'
    when p_event like 'chat.%'        then 'messages'
    when p_event like 'accounting.%'  then 'accounting'
    when p_event like 'pay.%'         then 'pay'
    when p_event like 'approval.%'    then 'approvals'
    when p_event like 'admin.%'       then 'announcements'
    when p_event like 'account.%'     then 'system'
    when p_event like 'security.%'    then 'system'
    else 'system'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. THE RECORD ITSELF
-- ---------------------------------------------------------------------------
create table if not exists public.notify_messages (
  id          uuid primary key default gen_random_uuid(),
  user_uid    text not null,                       -- the recipient's staff id
  event       text not null,
  category    text not null references public.notify_categories(id),
  title       text not null,
  body        text not null default '',
  item_id     text,                                -- app item id to open, never a URL
  actor_name  text not null default 'Larsa Control',
  -- Idempotency. The same real-world event raised twice — a double-tapped
  -- Approve, a retried save, two tabs open — must not become two rows in
  -- somebody's bell. Callers pass a stable key; the unique index below is
  -- what actually enforces it.
  dedupe_key  text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  archived_at timestamptz
);

create unique index if not exists notify_messages_dedupe_uq
  on public.notify_messages (user_uid, dedupe_key) where dedupe_key is not null;
create index if not exists notify_messages_feed_idx
  on public.notify_messages (user_uid, created_at desc);
-- The bell's badge is read on every page load, so give the unread count its
-- own partial index rather than making it walk the whole feed.
create index if not exists notify_messages_unread_idx
  on public.notify_messages (user_uid) where read_at is null and archived_at is null;

-- ---------------------------------------------------------------------------
-- 3. PREFERENCES — external delivery only
-- Note what is absent: there is no in_app column. The bell is not a channel
-- you can switch off, so it is not represented as one.
-- ---------------------------------------------------------------------------
create table if not exists public.notify_prefs (
  user_uid     text not null,
  category     text not null references public.notify_categories(id),
  push_enabled boolean not null default true,
  mail_enabled boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (user_uid, category)
);

create table if not exists public.notify_settings (
  user_uid      text primary key,
  -- Quiet hours are local wall-clock hours, 0-23, and wrap midnight: 22 -> 7
  -- means "quiet from ten at night until seven in the morning". NULL on
  -- either side means quiet hours are off. A notification raised during
  -- quiet hours still lands in the bell instantly — only the push is held.
  quiet_from    smallint check (quiet_from between 0 and 23),
  quiet_to      smallint check (quiet_to between 0 and 23),
  badge_enabled boolean not null default true,
  sound_enabled boolean not null default true,
  tz            text not null default 'Asia/Baghdad',
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. DEVICES
-- push_subscriptions already existed and already holds live subscriptions, so
-- it is extended in place rather than replaced — dropping it would silently
-- unsubscribe every device that is working today.
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions
  add column if not exists device_label text,
  add column if not exists user_agent   text,
  add column if not exists platform     text,
  add column if not exists enabled      boolean not null default true,
  add column if not exists last_seen_at timestamptz not null default now();

create index if not exists push_subscriptions_staff_idx
  on public.push_subscriptions (staff_uid) where enabled;

-- ---------------------------------------------------------------------------
-- 5. OUTBOX AND DELIVERY RECORDS
-- The client used to hand send-push a title and a body of its choosing, for
-- any staff id it named. That let any signed-in browser put arbitrary text on
-- any colleague's lock screen. Now the client can only raise a notification;
-- the push payload is composed HERE, from the stored record, and the sender
-- reads it from this outbox. What is on the lock screen is therefore always
-- something the database agreed to say.
-- ---------------------------------------------------------------------------
create table if not exists public.notify_outbox (
  id              uuid primary key default gen_random_uuid(),
  idem_key        text not null unique,
  notification_id uuid references public.notify_messages(id) on delete cascade,
  user_uid        text not null,
  category        text not null,
  title           text not null,
  body            text not null default '',
  url             text not null default '/',
  status          text not null default 'queued'
                  check (status in ('queued','sending','sent','skipped','failed')),
  attempts        int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists notify_outbox_queue_idx
  on public.notify_outbox (created_at) where status in ('queued','sending');

create table if not exists public.notify_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notify_messages(id) on delete cascade,
  outbox_id       uuid,
  user_uid        text not null,
  channel         text not null check (channel in ('push','mail')),
  target          text,           -- push endpoint host, or a masked address
  status          text not null check (status in ('sent','failed','skipped','expired')),
  detail          text,
  attempted_at    timestamptz not null default now()
);
create index if not exists notify_deliveries_msg_idx
  on public.notify_deliveries (notification_id);

-- ---------------------------------------------------------------------------
-- 6. LOCK THE TABLES DOWN
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'notify_messages','notify_prefs','notify_settings','notify_outbox',
    'notify_deliveries','notify_categories','push_subscriptions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- push_subscriptions carried a policy of USING (true): every browser holding
-- the anon key could read every push endpoint in the company. Nothing selects
-- through it any more, so it goes.
drop policy if exists "authenticated read/write" on public.push_subscriptions;

-- ---------------------------------------------------------------------------
-- 7. ACTOR
-- Same self-asserted shape as acct_*/pay_*: the client says who it is. The
-- functions below all filter by this id, so the worst a forged actor buys is
-- what forging a session already buys. What it prevents is the accidental
-- case — a stale tab, a shared browser — quietly reading somebody else's bell.
-- ---------------------------------------------------------------------------
create or replace function public.notify_actor_uid(actor jsonb)
returns text
language plpgsql stable
set search_path = public, pg_temp
as $$
declare uid text := trim(coalesce(actor->>'id',''));
begin
  if uid = '' then
    raise exception 'NOTIFY_ACTOR: a signed-in staff id is required';
  end if;
  return uid;
end;
$$;

-- What a push is allowed to say out loud. A pay or accounting notification
-- can name itself but never its number, because a preview appears on a locked
-- phone, in a notification shade, on a watch — places where the person who
-- reads it is not necessarily the person it belongs to. The figure stays
-- behind the tap, in the record, where opening it required signing in.
create or replace function public.notify_push_body(p_category text, p_body text)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select case
    when coalesce((select sensitive from public.notify_categories where id = p_category), false)
      then 'Open Larsa Control to view the details.'
    else left(coalesce(p_body, ''), 180)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RAISING A NOTIFICATION
-- p_rows: [{ userUid, event, title, body, itemId, dedupeKey, meta }]
-- The bell row is written unconditionally. The outbox row is written too —
-- whether it actually goes anywhere is decided later, by the sender, against
-- that person's preferences, quiet hours, and devices. Deciding it here would
-- bake one device's idea of the preferences into a permanent record.
-- ---------------------------------------------------------------------------
create or replace function public.notify_raise(actor jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_name  text := coalesce(nullif(trim(actor->>'name'),''), 'Larsa Control');
  row_in  jsonb;
  msg_id  uuid;
  made    int := 0;
  skipped int := 0;
  cat     text;
begin
  perform public.notify_actor_uid(actor);
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'NOTIFY_RAISE: p_rows must be an array';
  end if;

  for row_in in select * from jsonb_array_elements(p_rows) loop
    if coalesce(trim(row_in->>'userUid'),'') = '' or coalesce(trim(row_in->>'title'),'') = '' then
      continue;
    end if;
    cat := public.notify_event_category(coalesce(row_in->>'event','system'));

    insert into public.notify_messages
      (user_uid, event, category, title, body, item_id, actor_name, dedupe_key, meta)
    values (
      trim(row_in->>'userUid'),
      coalesce(nullif(trim(row_in->>'event'),''), 'system'),
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

    insert into public.notify_outbox
      (idem_key, notification_id, user_uid, category, title, body, url)
    values (
      'msg:' || msg_id::text,
      msg_id,
      trim(row_in->>'userUid'),
      cat,
      left(trim(row_in->>'title'), 200),
      public.notify_push_body(cat, row_in->>'body'),
      '/?n=' || msg_id::text
    )
    on conflict (idem_key) do nothing;

    msg_id := null;
  end loop;

  return jsonb_build_object('ok', true, 'created', made, 'deduped', skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. READING THE FEED
-- scope: 'unread' | 'all' | 'archived'. Archived rows are excluded from the
-- other two scopes and from every count, but they are still there — the whole
-- point of archive rather than delete.
-- ---------------------------------------------------------------------------
create or replace function public.notify_feed(
  actor jsonb,
  p_scope text default 'all',
  p_search text default null,
  p_category text default null,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  uid   text := public.notify_actor_uid(actor);
  lim   int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  off   int  := greatest(coalesce(p_offset, 0), 0);
  q     text := nullif(trim(coalesce(p_search, '')), '');
  scope text := lower(coalesce(p_scope, 'all'));
  total int;
  rows  jsonb;
begin
  with base as (
    select m.*
    from public.notify_messages m
    where m.user_uid = uid
      and case scope
            when 'archived' then m.archived_at is not null
            when 'unread'   then m.read_at is null and m.archived_at is null
            else m.archived_at is null
          end
      and (p_category is null or m.category = p_category)
      and (q is null or m.title ilike '%'||q||'%' or m.body ilike '%'||q||'%'
           or m.actor_name ilike '%'||q||'%')
  ),
  -- count(*) over () is evaluated before LIMIT, so one pass yields both the
  -- page and the true total the pager needs — no second scan of the feed.
  page as (
    select b.id, b.event, b.category, b.title, b.body, b.item_id, b.actor_name,
           b.created_at, b.read_at, b.archived_at, b.meta,
           count(*) over ()::int as total_count
    from base b order by b.created_at desc limit lim offset off
  )
  select coalesce(max(p.total_count), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'event', p.event, 'category', p.category,
           'title', p.title, 'body', p.body, 'itemId', p.item_id,
           'actorName', p.actor_name, 'createdAt', p.created_at,
           'readAt', p.read_at, 'archivedAt', p.archived_at, 'meta', p.meta
         ) order by p.created_at desc), '[]'::jsonb)
    into total, rows
  from page p;

  return jsonb_build_object(
    'ok', true, 'scope', scope, 'total', coalesce(total, 0),
    'limit', lim, 'offset', off,
    'items', coalesce(rows, '[]'::jsonb)
  );
end;
$$;

create or replace function public.notify_counts(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor);
begin
  return (
    select jsonb_build_object(
      'ok', true,
      'unread',   count(*) filter (where read_at is null and archived_at is null),
      'all',      count(*) filter (where archived_at is null),
      'archived', count(*) filter (where archived_at is not null),
      'byCategory', coalesce((
        select jsonb_object_agg(category, n) from (
          select category, count(*)::int n
          from public.notify_messages
          where user_uid = uid and read_at is null and archived_at is null
          group by category
        ) c), '{}'::jsonb)
    )
    from public.notify_messages where user_uid = uid
  );
end;
$$;

-- One entry point for every state change on a row, so "can this person touch
-- this row" is written once instead of five times.
create or replace function public.notify_mark(actor jsonb, p_ids uuid[], p_action text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  uid  text := public.notify_actor_uid(actor);
  act  text := lower(coalesce(p_action, ''));
  hit  int;
begin
  if act not in ('read','unread','archive','unarchive') then
    raise exception 'NOTIFY_MARK: unknown action %', p_action;
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return jsonb_build_object('ok', true, 'changed', 0);
  end if;

  update public.notify_messages m set
    read_at = case
                when act = 'read'   then coalesce(m.read_at, now())
                when act = 'unread' then null
                else m.read_at end,
    archived_at = case
                when act = 'archive'   then coalesce(m.archived_at, now())
                when act = 'unarchive' then null
                else m.archived_at end
  where m.id = any(p_ids)
    and m.user_uid = uid;          -- the whole authorisation check, right here
  get diagnostics hit = row_count;

  return jsonb_build_object('ok', true, 'changed', hit);
end;
$$;

create or replace function public.notify_mark_all_read(actor jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor); hit int;
begin
  update public.notify_messages set read_at = now()
   where user_uid = uid and read_at is null and archived_at is null;
  get diagnostics hit = row_count;
  return jsonb_build_object('ok', true, 'changed', hit);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. PREFERENCES AND DEVICES
-- notify_setup returns everything the settings screen needs in one round trip:
-- the twelve categories, this person's answers, their quiet hours, and every
-- device they have ever enabled push on.
-- ---------------------------------------------------------------------------
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
        -- Absent row means "never answered", which means the default, not off.
        'push', coalesce(p.push_enabled, true),
        'mail', coalesce(p.mail_enabled, false)
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
  insert into public.notify_prefs (user_uid, category, push_enabled, mail_enabled, updated_at)
  values (uid, p_category, coalesce(p_push, true), coalesce(p_mail, false), now())
  on conflict (user_uid, category) do update
    set push_enabled = excluded.push_enabled,
        mail_enabled = excluded.mail_enabled,
        updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.notify_set_settings(actor jsonb, p_patch jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  uid text := public.notify_actor_uid(actor);
  qf  smallint := nullif(p_patch->>'quietFrom','')::smallint;
  qt  smallint := nullif(p_patch->>'quietTo','')::smallint;
begin
  if (qf is null) <> (qt is null) then
    raise exception 'NOTIFY_SETTINGS: quiet hours need both a start and an end';
  end if;
  insert into public.notify_settings (user_uid, quiet_from, quiet_to, badge_enabled, sound_enabled, tz, updated_at)
  values (uid, qf, qt,
          coalesce((p_patch->>'badge')::boolean, true),
          coalesce((p_patch->>'sound')::boolean, true),
          coalesce(nullif(trim(p_patch->>'tz'),''), 'Asia/Baghdad'), now())
  on conflict (user_uid) do update
    set quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to,
        badge_enabled = excluded.badge_enabled, sound_enabled = excluded.sound_enabled,
        tz = excluded.tz, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.notify_register_device(
  actor jsonb, p_endpoint text, p_p256dh text, p_auth text,
  p_label text default null, p_ua text default null, p_platform text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor);
begin
  if coalesce(trim(p_endpoint),'') = '' or coalesce(trim(p_p256dh),'') = ''
     or coalesce(trim(p_auth),'') = '' then
    raise exception 'NOTIFY_DEVICE: endpoint, p256dh and auth are all required';
  end if;
  -- An endpoint is issued by the browser's push service and identifies one
  -- browser profile on one device. If it moves to a different staff id, the
  -- person on that device changed — the row follows the endpoint, so the old
  -- account stops receiving on hardware it no longer sits in front of.
  insert into public.push_subscriptions
    (staff_uid, endpoint, p256dh, auth, device_label, user_agent, platform, enabled, last_seen_at)
  values (uid, trim(p_endpoint), trim(p_p256dh), trim(p_auth),
          left(nullif(trim(coalesce(p_label,'')),''), 60),
          left(coalesce(p_ua,''), 400), left(coalesce(p_platform,''), 60), true, now())
  on conflict (endpoint) do update
    set staff_uid = excluded.staff_uid, p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = coalesce(excluded.device_label, public.push_subscriptions.device_label),
        user_agent = excluded.user_agent, platform = excluded.platform,
        enabled = true, last_seen_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.notify_device_update(
  actor jsonb, p_id uuid, p_enabled boolean default null, p_label text default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor); hit int;
begin
  update public.push_subscriptions
     set enabled = coalesce(p_enabled, enabled),
         device_label = coalesce(left(nullif(trim(coalesce(p_label,'')),''), 60), device_label)
   where id = p_id and staff_uid = uid;
  get diagnostics hit = row_count;
  return jsonb_build_object('ok', hit > 0);
end;
$$;

-- Signing out on a shared machine must not leave that machine receiving the
-- previous person's notifications. The client calls this on sign-out with the
-- endpoint it is about to unsubscribe locally; both halves matter, because
-- unsubscribing without deleting leaves a dead row the sender keeps retrying.
create or replace function public.notify_forget_device(actor jsonb, p_endpoint text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor); hit int;
begin
  delete from public.push_subscriptions
   where staff_uid = uid and endpoint = trim(coalesce(p_endpoint,''));
  get diagnostics hit = row_count;
  return jsonb_build_object('ok', true, 'removed', hit);
end;
$$;

create or replace function public.notify_remove_device(actor jsonb, p_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare uid text := public.notify_actor_uid(actor); hit int;
begin
  delete from public.push_subscriptions where id = p_id and staff_uid = uid;
  get diagnostics hit = row_count;
  return jsonb_build_object('ok', hit > 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. LEGACY IMPORT
-- The notifications already sitting in localStorage are somebody's history,
-- so they are carried over rather than abandoned. Idempotent by construction:
-- the old client-generated id becomes the dedupe key, so running this on a
-- second device — or twice on the same one — adds nothing new.
-- ---------------------------------------------------------------------------
create or replace function public.notify_import_legacy(actor jsonb, p_items jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  uid    text := public.notify_actor_uid(actor);
  row_in jsonb;
  made   int := 0;
begin
  if jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', true, 'imported', 0);
  end if;
  for row_in in select * from jsonb_array_elements(p_items) loop
    -- Only your own history. A device holding somebody else's leftover rows
    -- does not get to write them into that person's authoritative feed.
    continue when coalesce(trim(row_in->>'toId'),'') <> uid;
    continue when coalesce(trim(row_in->>'title'),'') = '';

    insert into public.notify_messages
      (user_uid, event, category, title, body, item_id, actor_name,
       dedupe_key, created_at, read_at, meta)
    values (
      uid,
      coalesce(nullif(trim(row_in->>'event'),''), 'system'),
      public.notify_event_category(coalesce(row_in->>'event','system')),
      left(trim(row_in->>'title'), 200),
      left(coalesce(row_in->>'body',''), 2000),
      nullif(trim(coalesce(row_in->>'itemId','')), ''),
      coalesce(nullif(trim(row_in->>'fromName'),''), 'Larsa Control'),
      'legacy:' || coalesce(row_in->>'id', md5(row_in::text)),
      coalesce((row_in->>'at')::timestamptz, now()),
      case when (row_in->>'read')::boolean then coalesce((row_in->>'at')::timestamptz, now()) end,
      jsonb_build_object('legacy', true)
    )
    on conflict (user_uid, dedupe_key) where dedupe_key is not null do nothing;
    if found then made := made + 1; end if;
  end loop;
  -- Deliberately no outbox rows: these already reached the person once. A
  -- migration is not an excuse to re-push last month's notifications.
  return jsonb_build_object('ok', true, 'imported', made);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. THE SENDER'S SIDE
-- These are called by the send-push Edge Function with the service role, and
-- are NOT granted to anon or authenticated — a browser has no business
-- claiming the outbox or writing delivery records.
-- ---------------------------------------------------------------------------

-- Quiet hours wrap midnight, which is the whole reason this is a function and
-- not an inline BETWEEN: 22 -> 7 is quiet at 23:00 and at 03:00, and a naive
-- range check gets both wrong.
create or replace function public.notify_in_quiet_hours(p_from smallint, p_to smallint, p_tz text)
returns boolean
language plpgsql stable
set search_path = public, pg_temp
as $$
declare h int;
begin
  if p_from is null or p_to is null then return false; end if;
  begin
    h := extract(hour from (now() at time zone coalesce(p_tz, 'Asia/Baghdad')))::int;
  exception when others then
    -- An unknown time zone must not silently swallow somebody's notifications.
    h := extract(hour from (now() at time zone 'Asia/Baghdad'))::int;
  end;
  if p_from = p_to then return false; end if;
  if p_from < p_to then return h >= p_from and h < p_to; end if;
  return h >= p_from or h < p_to;   -- wraps midnight
end;
$$;

-- Claims a batch of queued work and returns it already resolved: for each
-- outbox row, the devices it should actually reach. Doing the resolution here
-- rather than in the function keeps one definition of "should this be sent",
-- and means the sender needs no read access to preferences at all.
create or replace function public.notify_outbox_claim(p_limit int default 50)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare claimed uuid[]; out_rows jsonb;
begin
  with picked as (
    select o.id
    from public.notify_outbox o
    where o.status = 'queued'
       -- A row stuck in 'sending' is a sender that died mid-batch. Reclaim it
       -- after five minutes rather than leaving the notification stranded.
       or (o.status = 'sending' and o.claimed_at < now() - interval '5 minutes')
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    -- SKIP LOCKED is what makes two senders running at once safe: the second
    -- one steps over whatever the first already holds instead of blocking on
    -- it, and neither sends the same push twice.
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
    -- Resolved here so the sender only ever sees "send to these endpoints".
    'suppressed', case
        when not coalesce(p.push_enabled, true) then 'category-off'
        when public.notify_in_quiet_hours(s.quiet_from, s.quiet_to, s.tz) then 'quiet-hours'
        else null end,
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth))
      from public.push_subscriptions d
      where d.staff_uid = o.user_uid and d.enabled
    ), '[]'::jsonb)
  )), '[]'::jsonb) into out_rows
  from public.notify_outbox o
  left join public.notify_prefs p on p.user_uid = o.user_uid and p.category = o.category
  left join public.notify_settings s on s.user_uid = o.user_uid
  where o.id = any(claimed);

  return jsonb_build_object('ok', true, 'items', out_rows);
end;
$$;

create or replace function public.notify_outbox_finish(
  p_id uuid, p_status text, p_error text default null, p_deliveries jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare d jsonb; uid text; nid uuid;
begin
  if coalesce(p_status,'') not in ('sent','skipped','failed') then
    raise exception 'NOTIFY_OUTBOX: bad terminal status %', p_status;
  end if;
  update public.notify_outbox
     set status = p_status, last_error = left(coalesce(p_error,''), 500), finished_at = now()
   where id = p_id
   returning user_uid, notification_id into uid, nid;
  if uid is null then return jsonb_build_object('ok', false); end if;

  for d in select * from jsonb_array_elements(coalesce(p_deliveries, '[]'::jsonb)) loop
    insert into public.notify_deliveries
      (notification_id, outbox_id, user_uid, channel, target, status, detail)
    values (nid, p_id, uid,
            coalesce(nullif(d->>'channel',''), 'push'),
            -- Only the endpoint's host is kept. The full endpoint is a
            -- credential that can push to that device; a delivery log does
            -- not need to be a second copy of it.
            left(coalesce(d->>'target',''), 120),
            coalesce(nullif(d->>'status',''), 'failed'),
            left(coalesce(d->>'detail',''), 300));
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

-- A push service answering 404 or 410 means that subscription is dead. Pruning
-- it is what stops a replaced phone from generating a failure on every send
-- for the rest of the year.
create or replace function public.notify_prune_device(p_endpoint text)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare hit int;
begin
  delete from public.push_subscriptions where endpoint = p_endpoint;
  get diagnostics hit = row_count;
  return jsonb_build_object('ok', true, 'removed', hit);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. REALTIME
-- The bell on a laptop should go quiet when the same notification is read on a
-- phone. That needs a live signal, but Realtime's postgres_changes would need
-- a readable table, and this table is deliberately not readable. So the
-- broadcast carries NO CONTENT — it is a bare "something changed for you",
-- addressed to a per-person topic. The client answers it by calling
-- notify_counts, which re-checks the actor. Anyone who guessed a colleague's
-- topic would learn only that a notification exists, never what it says.
-- ---------------------------------------------------------------------------
create or replace function public.notify_ping()
returns trigger
language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('at', extract(epoch from now())),
      'changed',
      'notify:' || coalesce(new.user_uid, old.user_uid),
      false
    );
  exception when others then
    -- Realtime being unavailable must never roll back the notification that
    -- was just written. The bell is the record; the ping is a convenience.
    null;
  end;
  return null;
end;
$$;

drop trigger if exists notify_messages_ping on public.notify_messages;
create trigger notify_messages_ping
  after insert or update of read_at, archived_at on public.notify_messages
  for each row execute function public.notify_ping();

-- ---------------------------------------------------------------------------
-- 14. GRANTS
--
-- The revoke has to name PUBLIC, not just anon and authenticated. A function
-- is created with EXECUTE already granted to PUBLIC, so revoking it from anon
-- removes nothing — anon still reaches it through PUBLIC. Getting this wrong
-- left notify_outbox_claim callable by any browser holding the anon key,
-- which meant a client could claim the outbox and read the title and body
-- queued for anybody in the company.
--
-- So: revoke from PUBLIC first, then grant back to exactly the roles that
-- should have it. The client gets its fourteen entry points. The outbox
-- claim, the delivery writer and the device pruner go to service_role alone,
-- because those are the sender's and the sender holds the service role.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'notify_raise(jsonb, jsonb)',
    'notify_feed(jsonb, text, text, text, integer, integer)',
    'notify_counts(jsonb)',
    'notify_mark(jsonb, uuid[], text)',
    'notify_mark_all_read(jsonb)',
    'notify_setup(jsonb)',
    'notify_set_pref(jsonb, text, boolean, boolean)',
    'notify_set_settings(jsonb, jsonb)',
    'notify_register_device(jsonb, text, text, text, text, text, text)',
    'notify_device_update(jsonb, uuid, boolean, text)',
    'notify_forget_device(jsonb, text)',
    'notify_remove_device(jsonb, uuid)',
    'notify_import_legacy(jsonb, jsonb)',
    'notify_event_category(text)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', fn);
  end loop;

  foreach fn in array array[
    'notify_outbox_claim(integer)',
    'notify_outbox_finish(uuid, text, text, jsonb)',
    'notify_prune_device(text)',
    'notify_push_body(text, text)',
    'notify_in_quiet_hours(smallint, smallint, text)',
    'notify_actor_uid(jsonb)',
    'notify_ping()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
