-- Keep organization structure from disappearing when an old browser writes
-- a partial larsaStaffV8 snapshot. Deliberate deletes carry explicit IDs in
-- org.removedDepartmentIds / org.removedTeamIds; missing rows alone never
-- count as a delete.

create or replace function public.larsa_org_guard_array(
  p_incoming jsonb,
  p_existing jsonb,
  p_removed jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_row jsonb;
  v_id text;
begin
  for v_row in
    select value from jsonb_array_elements(
      case when jsonb_typeof(p_incoming) = 'array' then p_incoming else '[]'::jsonb end
    ) with ordinality order by ordinality
  loop
    v_id := nullif(v_row->>'id', '');
    if v_id is not null and exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(p_removed) = 'array' then p_removed else '[]'::jsonb end
      ) removed(id) where removed.id = v_id
    ) then continue; end if;
    if v_id is not null and v_id = any(v_seen) then continue; end if;
    if v_id is not null then v_seen := array_append(v_seen, v_id); end if;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;

  for v_row in
    select value from jsonb_array_elements(
      case when jsonb_typeof(p_existing) = 'array' then p_existing else '[]'::jsonb end
    ) with ordinality order by ordinality
  loop
    v_id := nullif(v_row->>'id', '');
    if v_id is not null and v_id = any(v_seen) then continue; end if;
    if v_id is not null and exists (
      select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(p_removed) = 'array' then p_removed else '[]'::jsonb end
      ) removed(id) where removed.id = v_id
    ) then continue; end if;
    if v_id is not null then v_seen := array_append(v_seen, v_id); end if;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;
  return v_rows;
end;
$$;

create or replace function public.app_state_guard_org_structure()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old_org jsonb;
  v_new_org jsonb;
  v_org jsonb;
  v_removed_departments jsonb;
  v_removed_teams jsonb;
begin
  if new.store_key <> 'larsaStaffV8' or old.data is null or new.data is null then return new; end if;
  if current_setting('larsa.guard_bypass', true) = 'yes' then return new; end if;

  v_old_org := old.data->'org';
  if jsonb_typeof(v_old_org) <> 'object' then return new; end if;
  v_new_org := new.data->'org';
  if jsonb_typeof(v_new_org) <> 'object' then
    new.data := jsonb_set(new.data, '{org}', v_old_org, true);
    return new;
  end if;

  v_org := v_old_org || v_new_org;
  select coalesce(jsonb_agg(to_jsonb(id) order by first_ord), '[]'::jsonb)
    into v_removed_departments
  from (
    select id, min(ord) first_ord from (
      select value id, ordinality ord from jsonb_array_elements_text(
        case when jsonb_typeof(v_old_org->'removedDepartmentIds') = 'array' then v_old_org->'removedDepartmentIds' else '[]'::jsonb end
      ) with ordinality
      union all
      select value id, 1000000 + ordinality ord from jsonb_array_elements_text(
        case when jsonb_typeof(v_new_org->'removedDepartmentIds') = 'array' then v_new_org->'removedDepartmentIds' else '[]'::jsonb end
      ) with ordinality
    ) ids where id <> '' group by id
  ) unique_ids;

  select coalesce(jsonb_agg(to_jsonb(id) order by first_ord), '[]'::jsonb)
    into v_removed_teams
  from (
    select id, min(ord) first_ord from (
      select value id, ordinality ord from jsonb_array_elements_text(
        case when jsonb_typeof(v_old_org->'removedTeamIds') = 'array' then v_old_org->'removedTeamIds' else '[]'::jsonb end
      ) with ordinality
      union all
      select value id, 1000000 + ordinality ord from jsonb_array_elements_text(
        case when jsonb_typeof(v_new_org->'removedTeamIds') = 'array' then v_new_org->'removedTeamIds' else '[]'::jsonb end
      ) with ordinality
    ) ids where id <> '' group by id
  ) unique_ids;

  v_org := jsonb_set(v_org, '{departments}', public.larsa_org_guard_array(
    v_new_org->'departments', v_old_org->'departments', v_removed_departments
  ), true);
  v_org := jsonb_set(v_org, '{teams}', public.larsa_org_guard_array(
    v_new_org->'teams', v_old_org->'teams', v_removed_teams
  ), true);
  v_org := jsonb_set(v_org, '{removedDepartmentIds}', v_removed_departments, true);
  v_org := jsonb_set(v_org, '{removedTeamIds}', v_removed_teams, true);
  new.data := jsonb_set(new.data, '{org}', v_org, true);
  return new;
exception when others then
  raise warning 'app_state_guard_org_structure failed open: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists ab_app_state_guard_org_structure_trg on public.app_state;
create trigger ab_app_state_guard_org_structure_trg
  before update on public.app_state
  for each row execute function public.app_state_guard_org_structure();
