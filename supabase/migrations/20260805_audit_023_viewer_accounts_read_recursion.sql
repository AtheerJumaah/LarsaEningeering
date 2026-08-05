-- ============================================================
-- Larsa Control — audit 023: fix infinite recursion in the
-- viewer_accounts SELECT policy.
--
-- WHAT WAS BROKEN
-- The admin "Users & Access -> Viewer Accounts" panel always showed
-- "Could not load Viewer accounts. Check your connection and try again."
-- It loads the list with a direct PostgREST read:
--     supabase.from("viewer_accounts").select("*")
-- run from the browser's ordinary authenticated (anonymous) session
-- (app/page.tsx reloadViewers). That read evaluates the row-level
-- security policy below, and the policy — as originally written in
-- 20260803_acct_016_viewer_accounts.sql — asked its question with an
-- INLINE subquery against the very table it guards:
--
--     using (not (exists (select 1 from public.viewer_accounts self
--                          where self.auth_user_id = auth.uid()))
--            or auth_user_id = auth.uid());
--
-- That inline subquery runs as the querying role (authenticated), so it
-- is itself subject to this same SELECT policy, which runs the subquery
-- again, forever. Postgres detects it and aborts every read of the table
-- with: 42P17 "infinite recursion detected in policy for relation
-- viewer_accounts". Reproduced live against production by simulating a
-- real authenticated session.
--
-- Net effect: the Viewer Accounts admin panel could never list anything,
-- and a viewer's own session reading its single row would fail the same
-- way. The feature was dead for everyone.
--
-- WHY is_any_viewer() FIXES IT (and is provably the same rule)
-- is_any_viewer(uid) is defined in acct_016 as
--     select exists (select 1 from public.viewer_accounts where auth_user_id = uid)
-- so `not public.is_any_viewer(auth.uid())` is logically identical to the
-- inline `not exists (select 1 ... where self.auth_user_id = auth.uid())`
-- — the row-visibility rule does not change at all. The difference is that
-- is_any_viewer() is SECURITY DEFINER: its inner read of viewer_accounts
-- runs as the function owner with RLS bypassed, so it does not re-enter
-- this policy and cannot recurse. This is exactly the pattern every OTHER
-- viewer policy in acct_016/acct_020 already uses (acct_projects,
-- acct_transactions, acct_progress_updates, app_state,
-- account_lifecycle_audit). The viewer_accounts table's own read policy
-- was the single place that inlined the subquery instead — almost
-- certainly because at the point the policy was declared in acct_016,
-- is_any_viewer() was defined a few lines further down the same file and
-- could not be referenced yet. By this migration it has long existed, so
-- the policy can and does use it.
--
-- Access semantics preserved exactly:
--   * a non-viewer session (staff/admin) sees every viewer_accounts row,
--     for the admin directory;
--   * a viewer session sees only its own row and never another client's.
-- ============================================================

drop policy if exists "viewer_accounts read" on public.viewer_accounts;

create policy "viewer_accounts read" on public.viewer_accounts
  for select
  using (not public.is_any_viewer(auth.uid())
         or auth_user_id = auth.uid());

-- Grants. acct_016 created viewer_accounts but never spelled out its table
-- grants — in production they come from Supabase's project-level default
-- (all privileges to anon and authenticated, with RLS as the only gate).
-- Two consequences that matter now that the read above actually executes:
--
--   * authenticated must hold SELECT for the admin directory read and for a
--     viewer reading its own row. Production already grants it; stating it
--     here makes the migration self-contained and lets the local harness,
--     which does not replicate Supabase's default grants, reach RLS at all.
--
--   * anon (a request bearing only the public anon key, with no signed-in
--     session) must NOT read this table. While the policy recursed, nobody
--     could read it and the stray default grant was harmless; the moment the
--     recursion is gone, an anon caller would match `not is_any_viewer(null)`
--     = true and read every client's username and project scope. The app
--     never touches this table as anon — it waits for the anonymous sign-in
--     that makes the session `authenticated` before querying — so anon has no
--     legitimate need here. Revoke it so fixing the recursion cannot widen
--     exposure. (No-op on the local harness, where anon never had the grant.)
grant select on public.viewer_accounts to authenticated;
revoke all on public.viewer_accounts from anon;
