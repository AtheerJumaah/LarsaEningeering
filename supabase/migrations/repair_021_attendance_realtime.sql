-- repair_021 — publish the append-only attendance ledger for low-latency
-- cross-device updates. The existing app_state row remains the durable
-- working document; this adds only a small INSERT notification stream.
do $$
begin
  if to_regclass('public.attendance_events') is not null
     and not exists (
       select 1
       from pg_publication_rel pr
       join pg_publication p on p.oid = pr.prpubid
       where p.pubname = 'supabase_realtime'
         and pr.prrelid = 'public.attendance_events'::regclass
     ) then
    execute 'alter publication supabase_realtime add table public.attendance_events';
  end if;
end $$;
