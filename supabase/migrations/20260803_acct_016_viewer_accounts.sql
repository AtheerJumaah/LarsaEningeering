-- ============================================================
-- Larsa Control — Viewer accounts: a real, separate, server-enforced
-- identity for client-facing read-only accounts.
--
-- Context, stated plainly because it shapes every decision below: every
-- existing table's RLS in this project only checks auth.role() =
-- 'authenticated', which the anonymous session every browser tab creates
-- already satisfies (see app_state's policy and lib/supabase/sync.ts).
-- Every acct_*/pay_* RPC trusts a client-supplied {email, role} "actor"
-- jsonb at face value — it checks the role string is on an allowed list,
-- not that the caller genuinely holds that identity. That is a
-- deliberate, pre-existing, whole-app trade-off, already documented in
-- schema.sql's own comments as a separate, larger project ("give each
-- employee a real Supabase Auth account and rewrite RLS... ask for this
-- explicitly when you're ready"). This migration does NOT attempt that
-- replacement for the real employees already relying on today's model —
-- doing so live, for accounts signed in right now, is exactly the kind
-- of destructive architecture change to stop and flag rather than do
-- quietly.
--
-- Viewers are new, though. Nothing already depends on the trust-the-
-- client pattern for them, so they get it right from day one: a real
-- Supabase Auth identity (auth.uid()) per Viewer, backed by a synthetic
-- internal email derived from their username (this uses Supabase Auth's
-- own supported email+password mechanism — not a second bespoke
-- password system — so hashing, verification, and session issuance are
-- all handled by Supabase itself; the app never sees or stores a
-- Viewer's real password). Every policy below is RESTRICTIVE, which
-- Postgres ANDs together with the existing PERMISSIVE ones. For any
-- session that is not a registered viewer, "not is_any_viewer(...)" is
-- true and the restriction is a no-op — today's 27 real employee
-- sessions see zero change in behavior from this file.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table itself
-- ------------------------------------------------------------
create table if not exists public.viewer_accounts (
  id                   uuid primary key default gen_random_uuid(),
  auth_user_id         uuid not null unique references auth.users(id) on delete cascade,
  username             text not null unique,
  display_name         text not null,
  project_access_mode  text not null default 'assigned'
                       check (project_access_mode in ('all','assigned','none')),
  allowed_project_ids  text[] not null default '{}',
  enabled              boolean not null default true,
  expires_at           timestamptz,
  created_by           text,
  created_at           timestamptz not null default now(),
  updated_by           text,
  updated_at           timestamptz not null default now()
);

create index if not exists viewer_accounts_auth_idx on public.viewer_accounts (auth_user_id);

alter table public.viewer_accounts enable row level security;

-- Employees (today's authenticated-but-anonymous sessions) can list every
-- viewer account, same as they can already list every staff record in
-- app_state, for the admin UI. A viewer session sees only its own row —
-- one client should never learn another client's username or project
-- list through this table.
create policy "viewer_accounts read" on public.viewer_accounts
  for select
  using (not (exists (select 1 from public.viewer_accounts self where self.auth_user_id = auth.uid()))
         or auth_user_id = auth.uid());

-- Mutations happen only through the viewer-admin Edge Function's
-- service-role client, which enforces the actor-role check before ever
-- touching this table. No insert/update/delete policy is granted here,
-- so a client cannot create, edit, or delete a viewer account directly
-- against PostgREST no matter what it sends.

-- ------------------------------------------------------------
-- 2. Helper functions
-- ------------------------------------------------------------
create or replace function public.is_any_viewer(uid uuid)
returns boolean
language sql stable
security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.viewer_accounts where auth_user_id = uid);
$$;

create or replace function public.viewer_can_read_project(uid uuid, target_project_id text)
returns boolean
language sql stable
security definer set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when not v.enabled then false
      when v.expires_at is not null and v.expires_at < now() then false
      when v.project_access_mode = 'all' then true
      when v.project_access_mode = 'assigned' then target_project_id = any(v.allowed_project_ids)
      else false
    end
    from public.viewer_accounts v
    where v.auth_user_id = uid
  ), false);
$$;

-- ------------------------------------------------------------
-- 3. Scoped read access — exactly the three tables that map to
--    "construction projects... project progress" for a Viewer. A
--    disabled or expired viewer_accounts row makes viewer_can_read_project
--    false for every project, so it also acts as the enabled/expiry gate.
--    (No table in this schema stores files/documents yet, so "approved
--    files/documents" from the spec has nothing to scope today.)
-- ------------------------------------------------------------
create policy "viewer scoped read" on public.acct_projects
  as restrictive for select
  using (not public.is_any_viewer(auth.uid()) or public.viewer_can_read_project(auth.uid(), id));

create policy "viewer scoped read" on public.acct_transactions
  as restrictive for select
  using (not public.is_any_viewer(auth.uid()) or public.viewer_can_read_project(auth.uid(), project_id));

create policy "viewer scoped read" on public.acct_progress_updates
  as restrictive for select
  using (not public.is_any_viewer(auth.uid()) or public.viewer_can_read_project(auth.uid(), project_id));

-- ------------------------------------------------------------
-- 4. Everything else a Viewer's authenticated JWT would otherwise reach
--    (it satisfies auth.role() = 'authenticated' same as anyone signed
--    in) gets closed outright. This is every remaining table that
--    currently has a permissive policy at all; every other table
--    (pay_*, notify_*, auth_codes, auth_policy*, user_verification,
--    platform_admins, push_subscriptions) already has RLS enabled with
--    NO policy, so it is already unreachable by any client — viewer or
--    not — and needs nothing added here.
-- ------------------------------------------------------------
create policy "viewer blocked" on public.app_state
  as restrictive for all
  using (not public.is_any_viewer(auth.uid()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'acct_approval_requests', 'acct_archives', 'acct_audit', 'acct_fee_ledger',
    'acct_permissions', 'acct_platform_settings', 'acct_receipt_prints',
    'acct_receipts', 'acct_refund_settlements', 'acct_review_queue'
  ]
  loop
    execute format(
      'create policy %I on public.%I as restrictive for all using (not public.is_any_viewer(auth.uid()))',
      'viewer blocked', t
    );
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 5. One escalation path closed regardless of the trust model above:
--    no write to app_state (the staff blob every employee session can
--    already write to) can mint a new Super Admin or touch the
--    protected owner account. The app's own client code already
--    refuses to do either through the UI; this makes it a real,
--    unbypassable guarantee against a direct API/DB write too. This
--    does not, and cannot, close general role tampering for every other
--    role from a crafted direct write — that remains the pre-existing,
--    whole-app limitation described above, out of scope for this
--    change.
-- ------------------------------------------------------------
create or replace function public.app_state_guard_super_admin()
returns trigger
language plpgsql
as $$
declare
  old_admins jsonb;
  new_admins jsonb;
  rec jsonb;
begin
  if new.store_key <> 'larsaStaffV8' or TG_OP <> 'UPDATE' then
    return new;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', u->>'id', 'email', lower(coalesce(u->>'email','')))), '[]'::jsonb)
    into old_admins
    from jsonb_array_elements(coalesce(old.data->'users', '[]'::jsonb)) u
   where u->>'access' = 'Super Admin';

  select coalesce(jsonb_agg(jsonb_build_object('id', u->>'id', 'email', lower(coalesce(u->>'email','')))), '[]'::jsonb)
    into new_admins
    from jsonb_array_elements(coalesce(new.data->'users', '[]'::jsonb)) u
   where u->>'access' = 'Super Admin';

  for rec in select * from jsonb_array_elements(new_admins)
  loop
    if not exists (select 1 from jsonb_array_elements(old_admins) o where o->>'id' = rec->>'id') then
      raise exception 'ACCOUNT_GUARD: this write would grant Super Admin to user id=% who was not already Super Admin — rejected', rec->>'id';
    end if;
  end loop;

  for rec in select * from jsonb_array_elements(old_admins)
  loop
    if not exists (select 1 from jsonb_array_elements(new_admins) n where n->>'id' = rec->>'id' and n->>'email' = rec->>'email') then
      raise exception 'ACCOUNT_GUARD: this write would remove or modify the protected Super Admin account id=% — rejected', rec->>'id';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists app_state_guard_super_admin_trg on public.app_state;
create trigger app_state_guard_super_admin_trg
  before insert or update on public.app_state
  for each row execute function public.app_state_guard_super_admin();

-- ------------------------------------------------------------
-- 6. Account lifecycle audit log. Never stores a password, PIN, hash,
--    or reset token — only who did what to which account, when.
-- ------------------------------------------------------------
create table if not exists public.account_lifecycle_audit (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),
  actor_email  text,
  actor_role   text,
  action       text not null,
  target_type  text not null,
  target_id    text,
  target_label text,
  details      jsonb not null default '{}'::jsonb
);

create index if not exists account_lifecycle_audit_at_idx on public.account_lifecycle_audit (at desc);

alter table public.account_lifecycle_audit enable row level security;

create policy "account_lifecycle_audit read" on public.account_lifecycle_audit
  for select
  using (auth.role() = 'authenticated');

create policy "viewer blocked" on public.account_lifecycle_audit
  as restrictive for all
  using (not public.is_any_viewer(auth.uid()));

-- No direct insert policy: rows are written only by this RPC (used by
-- the client for the account actions that stay client/localStorage
-- driven — approve, reject, role change, activate/deactivate) or by the
-- viewer-admin Edge Function's own service-role client (which bypasses
-- RLS entirely and logs its own actions directly).
create or replace function public.account_audit_log(
  actor jsonb, p_action text, p_target_type text, p_target_id text default null,
  p_target_label text default null, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  a_email text := lower(coalesce(actor->>'email',''));
begin
  if a_email = '' or position('@' in a_email) = 0 then
    raise exception 'ACCOUNT_AUDIT: a valid actor email is required';
  end if;
  insert into public.account_lifecycle_audit (actor_email, actor_role, action, target_type, target_id, target_label, details)
  values (a_email, coalesce(nullif(actor->>'role',''), actor->>'access', ''), p_action, p_target_type, p_target_id, p_target_label,
          coalesce(p_details, '{}'::jsonb));
end;
$$;
