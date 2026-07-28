-- Larsa Control -- Supabase schema
--
-- What this is: the app keeps its three existing localStorage stores
-- (Timeclock/staff, HR, Accounting) exactly as they are today -- same JSON
-- shape, same keys the app already reads and writes. This schema gives each
-- of those three JSON blobs a home in Postgres instead of one browser, so
-- everyone in the company sees the same data instead of only what is on
-- their own machine.
--
-- This is deliberately NOT a full relational rebuild of every collection
-- (ledgers, commissions, HR records, etc.) into its own table. That is a
-- larger, separate project -- see the note at the bottom of this file. What
-- is here solves the actual problem you hit today: "what I enter on my
-- laptop doesn't show up on a colleague's machine."
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query -> paste -> Run) on a brand new project, before the app is pointed
-- at it.

create table if not exists public.app_state (
  store_key   text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- The three keys the app already uses. Seeding them here just means the
-- table has a row to update on first load; the app overwrites this the
-- first time someone signs in and the local browser has real data.
insert into public.app_state (store_key, data) values
  ('larsaStaffV8', '{}'::jsonb),
  ('larsa_enterprise_v3_new_account_20260630_v34_clean', '{}'::jsonb),
  ('larsa_hr_visual_counts_v5', '{}'::jsonb)
on conflict (store_key) do nothing;

alter table public.app_state enable row level security;

-- Security model, stated plainly:
--
-- The app has no server and never has -- every permission check (who can
-- see what, who can approve what) happens in the browser today, exactly as
-- it does now. Moving to Supabase does not change that model or make it
-- weaker; it closes the one gap a browser-only app has, which is that
-- anyone who found the API URL and key could otherwise read or write this
-- table with no session at all.
--
-- The policy below requires a real Supabase session (including an
-- anonymous one, which the app creates silently on load -- see
-- lib/supabase/sync.ts). That blocks cold, unauthenticated requests from
-- outside the app. It does NOT add per-role or per-field server-side
-- enforcement -- that would mean giving every employee a real Supabase
-- account and moving today's client-side permission checks into RLS
-- policies, which is a real project of its own, described at the bottom of
-- this file.
create policy "authenticated read/write" on public.app_state
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Lets the app subscribe to changes and push updates to every open browser
-- within a second or two, instead of everyone having to refresh.
alter publication supabase_realtime add table public.app_state;

-- ---------------------------------------------------------------------
-- Anonymous auth must be turned on for the policy above to work, since the
-- app signs everyone in anonymously before it ever shows the sign-in
-- screen. In the Supabase dashboard: Authentication -> Sign In / Providers
-- -> Anonymous Sign-ins -> enable.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Next real step, when you want it (not done here): give each employee an
-- actual Supabase Auth account (email + password, created from the
-- existing staff list) and rewrite the RLS policies to check auth.uid()
-- against a staff_users table with a DataScope/role column, so Postgres --
-- not just the browser -- enforces who can read and write what. That turns
-- today's UI-level permission model into a server-enforced one. Ask for
-- this explicitly when you're ready; it touches the sign-in screen and is
-- worth doing as its own reviewed change, not bundled into a hosting move.
-- ---------------------------------------------------------------------
