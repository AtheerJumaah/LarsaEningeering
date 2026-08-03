-- ============================================================================
-- DELIVERY MUST NOT DEPEND ON A BROWSER BEING OPEN
--
-- Until now the only thing that ever asked the sender to run was the client,
-- fire-and-forget, right after raising a notification. That is wrong twice
-- over. First, the browser's call was being blocked by CORS before it left the
-- page — the send-push function answered the preflight with 405 and no
-- Access-Control-Allow-Origin — and the failure was swallowed, so nothing
-- drained at all. Second, and more fundamentally: the whole point of a push is
-- to reach somebody whose app is CLOSED. Making the closed app responsible for
-- triggering its own delivery is a contradiction, and it is exactly why a
-- phone in a pocket got nothing until it was picked up and opened.
--
-- So the database dispatches. notify_raise queues the work and then asks the
-- sender to run, over pg_net, asynchronously — the caller never waits on it
-- and never fails because of it. A one-minute pg_cron sweep is the backstop
-- for anything that still slips through: a dropped HTTP call, a sender that
-- died mid-batch, a notification raised while the function was redeploying.
-- ============================================================================
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- The sender's URL and the key used to call it. The anon key is already public
-- — it ships in the client bundle — but it lives in Vault rather than inline
-- so rotating it is a one-row update instead of a migration.
do $blk$
begin
  if not exists (select 1 from vault.secrets where name = 'notify_send_push_url') then
    perform vault.create_secret(
      'https://fqxknodpkjdmueevafdk.supabase.co/functions/v1/send-push',
      'notify_send_push_url',
      'Endpoint the notification outbox dispatcher calls');
  end if;
  -- notify_send_push_key is created out of band rather than in source control.
  -- If it is absent, notify_dispatch is a no-op and the cron sweep logs
  -- nothing; the bell still works, only external alerts stop.
end $blk$;

create or replace function public.notify_dispatch()
returns void
language plpgsql
security definer set search_path = public, extensions, pg_temp
as $fn$
declare u text; k text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name = 'notify_send_push_url';
  select decrypted_secret into k from vault.decrypted_secrets where name = 'notify_send_push_key';
  if u is null or k is null then return; end if;

  perform net.http_post(
    url     := u,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    body    := jsonb_build_object('limit', 100),
    timeout_milliseconds := 20000
  );
exception when others then
  -- A dispatch that cannot be queued must never roll back the notification it
  -- was queued for. The cron sweep will pick the work up within the minute.
  null;
end;
$fn$;

revoke all on function public.notify_dispatch() from public, anon, authenticated;
grant execute on function public.notify_dispatch() to service_role;

-- notify_raise dispatches at the end of the batch: once per call, not once per
-- recipient, so an announcement to forty people is one HTTP request.
create or replace function public.notify_raise(actor jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer set search_path = public, extensions, pg_temp
as $fn$
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
    msg_id := null;

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
  end loop;

  -- Hand the work to the sender without waiting for it.
  if made > 0 then perform public.notify_dispatch(); end if;

  return jsonb_build_object('ok', true, 'created', made, 'deduped', skipped);
end;
$fn$;

revoke all on function public.notify_raise(jsonb, jsonb) from public;
grant execute on function public.notify_raise(jsonb, jsonb) to anon, authenticated, service_role;

-- The backstop. Every minute, if anything is still waiting, ask again.
do $blk$
begin
  perform cron.unschedule('notify-drain-outbox');
exception when others then null;
end $blk$;

select cron.schedule(
  'notify-drain-outbox',
  '* * * * *',
  $cron$
    select public.notify_dispatch()
    where exists (
      select 1 from public.notify_outbox
      where status = 'queued'
         or (status = 'sending' and claimed_at < now() - interval '5 minutes')
    );
  $cron$
);
