-- ============================================================================
-- WHAT A CLIENT SEES IS TWO ANSWERS, NOT ONE
--
-- Until now a Viewer either could or could not read a project, and if they
-- could, they saw everything the portal knew how to draw. That is one answer
-- doing the work of two, and it is the wrong shape: a client who should see
-- progress is not thereby a client who should see every note an engineer left
-- on it.
--
-- So there are now three gates, and all three must open:
--
--   1. Is this project assigned to this Viewer?      (viewer_accounts, as before)
--   2. Is this SECTION switched on for that pairing? (viewer_project_sections)
--   3. Is this individual RECORD marked client-visible? (client_visible)
--
-- Every one of them fails closed. A section with no row is off. A record with
-- no flag is Internal Only. Assigning a project to a Viewer therefore shows
-- them nothing at all until somebody deliberately decides what they may see,
-- which is the right way round for a client-facing surface: the mistake it
-- makes under uncertainty is showing too little.
--
-- Note on scope: the sections listed here are the ones this system actually
-- holds data for. There is no file storage in this project — no buckets, no
-- objects — so drawings, site photos and document libraries have nothing to
-- expose yet. Rather than ship switches that could never turn anything on,
-- the enumeration stops at what exists and grows when the content does.
-- ============================================================================

-- ------------------------------------------------------- 1. section grants
create table if not exists public.viewer_project_sections (
  viewer_id   uuid not null references public.viewer_accounts(id) on delete cascade,
  project_id  text not null references public.acct_projects(id) on delete cascade,
  section     text not null check (section in (
                'overview',        -- name, number, client, status
                'progress',        -- approved progress percentage and milestones
                'schedule',        -- simplified dates
                'updates',         -- client-visible progress notes
                'financials'       -- the curated funding/spend summary
              )),
  enabled     boolean not null default false,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (viewer_id, project_id, section)
);

alter table public.viewer_project_sections enable row level security;
-- No policy: like every other admin-owned table here, clients never read it
-- directly. The SECURITY DEFINER helpers below are the only way in.
revoke all on public.viewer_project_sections from anon, authenticated;

comment on table public.viewer_project_sections is
  'Per-viewer, per-project section grants. Absence of a row means OFF: a '
  'client sees a section only when somebody switched it on for that project.';

-- ------------------------------------------------ 2. client-visible content
-- Internal Only is the default and it is NOT NULL, so a row written by any
-- existing code path — none of which knows this column exists — is internal.
-- Making it visible has to be a deliberate act.
alter table public.acct_progress_updates
  add column if not exists client_visible boolean not null default false;

alter table public.acct_progress_updates
  add column if not exists client_visible_by text;
alter table public.acct_progress_updates
  add column if not exists client_visible_at timestamptz;

create index if not exists acct_progress_client_visible_idx
  on public.acct_progress_updates (project_id, client_visible);

-- --------------------------------------------------------- 3. the gate
create or replace function public.viewer_section_enabled(uid uuid, target_project_id text, p_section text)
returns boolean
language sql stable
security definer set search_path = public, pg_temp
as $$
  -- Both halves must hold: the project has to be assigned AND the section
  -- switched on. Checking only the section would let a revoked project keep
  -- leaking through a grant nobody thought to clean up.
  select public.viewer_can_read_project(uid, target_project_id)
     and coalesce((
       select s.enabled
       from public.viewer_project_sections s
       join public.viewer_accounts v on v.id = s.viewer_id
       where v.auth_user_id = uid
         and s.project_id = target_project_id
         and s.section = p_section
     ), false);
$$;

revoke all on function public.viewer_section_enabled(uuid, text, text) from public, anon;
grant execute on function public.viewer_section_enabled(uuid, text, text) to authenticated;

-- ------------------------------------------- 4. tightening the row policies
-- Progress updates were scoped by project alone. Now a Viewer additionally
-- needs the 'updates' section, and the individual row has to be marked
-- client-visible. Non-viewer sessions are untouched: the first clause of the
-- RESTRICTIVE policy short-circuits for them exactly as before.
drop policy if exists "viewer scoped read" on public.acct_progress_updates;
create policy "viewer scoped read" on public.acct_progress_updates
  as restrictive for select
  using (
    not public.is_any_viewer(auth.uid())
    or (
      public.viewer_section_enabled(auth.uid(), project_id, 'updates')
      and client_visible
    )
  );

-- A Viewer reaching acct_transactions was already pointless — the portal never
-- queries it — but it was reachable in principle for an assigned project, and
-- a client has no business in the transaction ledger at all. Closed outright.
drop policy if exists "viewer scoped read" on public.acct_transactions;
create policy "viewer blocked" on public.acct_transactions
  as restrictive for select
  using (not public.is_any_viewer(auth.uid()));

-- The project row itself still needs to be readable for an assigned project,
-- but only when the overview section is on — otherwise "assigned" alone would
-- still disclose the client name and contract value.
drop policy if exists "viewer scoped read" on public.acct_projects;
create policy "viewer scoped read" on public.acct_projects
  as restrictive for select
  using (
    not public.is_any_viewer(auth.uid())
    or public.viewer_section_enabled(auth.uid(), id, 'overview')
  );

-- --------------------------------------- 5. the financial summary, re-gated
-- Same curated payload as before, with the section check added in front of
-- it. Without the financials section this returns null, not a stripped
-- object, so there is nothing to infer from the shape of the answer.
create or replace function public.viewer_project_summary(p_project_id text)
returns jsonb
language plpgsql
stable
security definer set search_path = public, pg_temp
as $$
declare full_summary jsonb;
begin
  if not public.viewer_section_enabled(auth.uid(), p_project_id, 'financials') then
    return null;
  end if;

  select public.acct_project_summary(p_project_id) into full_summary;
  if full_summary is null then return null; end if;

  return jsonb_build_object(
    'project_id',                       full_summary->>'project_id',
    'currency',                         full_summary->>'currency',
    'contract_value',                   full_summary->'contract_value',
    'approved_budget',                  full_summary->'approved_budget',
    'budget_currency',                  full_summary->>'budget_currency',
    'gross_funding_iqd',                full_summary->'gross_funding_iqd',
    'gross_funding_usd',                full_summary->'gross_funding_usd',
    'net_construction_funding_iqd',     full_summary->'net_construction_funding_iqd',
    'net_construction_funding_usd',     full_summary->'net_construction_funding_usd',
    'materials_iqd',                    full_summary->'materials_iqd',
    'materials_usd',                    full_summary->'materials_usd',
    'labor_iqd',                        full_summary->'labor_iqd',
    'labor_usd',                        full_summary->'labor_usd',
    'other_expenses_iqd',               full_summary->'other_expenses_iqd',
    'other_expenses_usd',               full_summary->'other_expenses_usd',
    'actual_construction_cost_iqd',     full_summary->'actual_construction_cost_iqd',
    'actual_construction_cost_usd',     full_summary->'actual_construction_cost_usd',
    'total_used_iqd',                   full_summary->'total_used_iqd',
    'total_used_usd',                   full_summary->'total_used_usd',
    'approved_remaining_balance_iqd',   full_summary->'approved_remaining_balance_iqd',
    'refunded_principal_iqd',           full_summary->'refunded_principal_iqd',
    'remaining_unused_iqd',             full_summary->'remaining_unused_iqd',
    'total_refund_due_iqd',             full_summary->'total_refund_due_iqd',
    'cost_progress_pct',                full_summary->'cost_progress_pct',
    'schedule_progress_pct',            full_summary->'schedule_progress_pct',
    'schedule_progress_date',           full_summary->'schedule_progress_date',
    'computed_at',                      full_summary->'computed_at'
  );
end;
$$;

revoke all on function public.viewer_project_summary(text) from public, anon;
grant execute on function public.viewer_project_summary(text) to authenticated;

-- ------------------------------------------------ 6. what the portal reads
-- One call, so the portal never has to ask "may I?" and then ask again for
-- the data — which is the pattern that turns into fetch-everything-then-hide
-- the moment somebody is in a hurry. Returns only enabled sections, and only
-- for assigned projects.
create or replace function public.viewer_my_projects()
returns jsonb
language plpgsql
stable
security definer set search_path = public, pg_temp
as $$
declare uid uuid := auth.uid(); rows_out jsonb;
begin
  if not public.is_any_viewer(uid) then
    return jsonb_build_object('ok', false, 'error', 'Not a Viewer account.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'code', p.code, 'name', p.name,
    'client', p.client, 'region', p.region, 'status', p.status,
    'sections', (
      select coalesce(jsonb_object_agg(s.section, s.enabled) filter (where s.enabled), '{}'::jsonb)
      from public.viewer_project_sections s
      join public.viewer_accounts v on v.id = s.viewer_id
      where v.auth_user_id = uid and s.project_id = p.id
    )
  ) order by p.name), '[]'::jsonb) into rows_out
  from public.acct_projects p
  where public.viewer_can_read_project(uid, p.id)
    -- A project with every section off is not shown at all. Listing it would
    -- tell the client a project exists that they may know nothing about.
    and exists (
      select 1 from public.viewer_project_sections s
      join public.viewer_accounts v on v.id = s.viewer_id
      where v.auth_user_id = uid and s.project_id = p.id and s.enabled
    );

  return jsonb_build_object('ok', true, 'projects', rows_out);
end;
$$;

revoke all on function public.viewer_my_projects() from public, anon;
grant execute on function public.viewer_my_projects() to authenticated;

-- ------------------------------------------------------- 7. admin plumbing
-- Setting a section, with the audit line that Part 7 asks for. Actor identity
-- is checked by account_audit_log, which refuses an actor with no valid email.
create or replace function public.viewer_section_set(
  actor jsonb, p_viewer_id uuid, p_project_id text, p_section text, p_enabled boolean)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare label text;
begin
  select display_name into label from public.viewer_accounts where id = p_viewer_id;
  if label is null then
    return jsonb_build_object('ok', false, 'error', 'No such Viewer account.');
  end if;

  insert into public.viewer_project_sections (viewer_id, project_id, section, enabled, updated_by, updated_at)
  values (p_viewer_id, p_project_id, p_section, coalesce(p_enabled, false),
          coalesce(nullif(trim(actor->>'name'),''), actor->>'email'), now())
  on conflict (viewer_id, project_id, section) do update
    set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();

  perform public.account_audit_log(actor, 'viewer.section_changed', 'viewer_account',
    p_viewer_id::text, label,
    jsonb_build_object('project', p_project_id, 'section', p_section, 'enabled', coalesce(p_enabled, false)));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.viewer_section_set(jsonb, uuid, text, text, boolean) from public, anon;
grant execute on function public.viewer_section_set(jsonb, uuid, text, text, boolean) to authenticated;

-- Reading them back for the admin screen.
create or replace function public.viewer_sections_list(actor jsonb, p_viewer_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare rows_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'projectId', s.project_id, 'section', s.section, 'enabled', s.enabled,
    'updatedBy', s.updated_by, 'updatedAt', s.updated_at)), '[]'::jsonb) into rows_out
  from public.viewer_project_sections s
  where s.viewer_id = p_viewer_id;
  return jsonb_build_object('ok', true, 'sections', rows_out);
end;
$$;

revoke all on function public.viewer_sections_list(jsonb, uuid) from public, anon;
grant execute on function public.viewer_sections_list(jsonb, uuid) to authenticated;

-- Flipping one progress update between Internal Only and Client Visible.
-- Deliberately one record at a time: a bulk "publish everything" button is
-- how internal notes reach a client by accident.
create or replace function public.acct_progress_visibility_set(
  actor jsonb, p_update_id uuid, p_client_visible boolean)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare pid text; who text;
begin
  who := coalesce(nullif(trim(actor->>'name'),''), actor->>'email');
  update public.acct_progress_updates
     set client_visible = coalesce(p_client_visible, false),
         client_visible_by = case when coalesce(p_client_visible,false) then who else null end,
         client_visible_at = case when coalesce(p_client_visible,false) then now() else null end
   where id = p_update_id
   returning project_id into pid;

  if pid is null then
    return jsonb_build_object('ok', false, 'error', 'No such progress update.');
  end if;

  perform public.account_audit_log(actor, 'content.visibility_changed', 'progress_update',
    p_update_id::text, pid,
    jsonb_build_object('project', pid, 'clientVisible', coalesce(p_client_visible, false)));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.acct_progress_visibility_set(jsonb, uuid, boolean) from public, anon;
grant execute on function public.acct_progress_visibility_set(jsonb, uuid, boolean) to authenticated;
