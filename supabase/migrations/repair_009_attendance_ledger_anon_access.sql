-- repair_009 — the attendance ledger must be readable by the app's clients.
--
-- The boot-time walk-back (reconcileStoreFromLedger) reads attendance_events
-- right after the first sync completes. Browsers hold a Supabase ANONYMOUS
-- session (role 'authenticated') — but at boot the read can race session
-- hydration and go out under the bare anon key. The SELECT policy admitted
-- only 'authenticated', so that read returned an EMPTY result (RLS filters,
-- no error) and the walk-back silently restored nothing — 87 genuinely lost
-- punches sat in the ledger for days while every boot "found nothing".
--
-- The shared staff document (app_state) is already readable with the anon
-- key, and it contains every punch — so admitting anon here exposes nothing
-- that is not already exposed, and it makes the durability loop actually
-- close. The table stays append-only: no UPDATE or DELETE policy exists.
drop policy if exists attendance_events_select on public.attendance_events;
create policy attendance_events_select on public.attendance_events
  for select to anon, authenticated using (true);
drop policy if exists attendance_events_insert on public.attendance_events;
create policy attendance_events_insert on public.attendance_events
  for insert to anon, authenticated with check (true);
