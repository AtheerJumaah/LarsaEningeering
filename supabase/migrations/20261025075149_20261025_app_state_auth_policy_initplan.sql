-- Evaluate auth context once per statement when reading or writing the
-- frequently queried shared-state row. The policy's access rules are
-- unchanged; only auth helper evaluation moves into an init plan.
drop policy if exists "authenticated read/write" on public.app_state;
create policy "authenticated read/write" on public.app_state
  as permissive for all to public
  using ((select auth.role()) = 'authenticated')
  with check ((select auth.role()) = 'authenticated');

drop policy if exists "viewer blocked" on public.app_state;
create policy "viewer blocked" on public.app_state
  as restrictive for all to public
  using (not public.is_any_viewer((select auth.uid())));
