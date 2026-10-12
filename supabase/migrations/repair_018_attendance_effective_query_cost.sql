-- Evaluate correction lookup and row conversion once, not once per expanded
-- composite column. Preserves the immutable ledger and effective chronology.
create or replace function public.attendance_effective_events(p_uid text)
returns setof public.attendance_events language sql stable security invoker
set search_path=pg_catalog,public as $$
  with corrected as materialized (
    select coalesce(jsonb_object_agg(l->>'id',l->>'time'),'{}'::jsonb) as times
    from public.app_state s,
      lateral jsonb_array_elements(coalesce(s.data->'logs','[]'::jsonb)) l
    where s.store_key='larsaStaffV8' and l->>'uid'=p_uid and l->>'id' is not null
  ), adjusted as materialized (
    select jsonb_populate_record(e,
      case when pg_input_is_valid(c.times->>e.client_event_id,'timestamptz')
        then jsonb_build_object('occurred_at',c.times->>e.client_event_id)
        else '{}'::jsonb end) as event
    from public.attendance_events e cross join corrected c where e.uid=p_uid
  )
  select (event).* from adjusted;
$$;
revoke all on function public.attendance_effective_events(text) from public;
grant execute on function public.attendance_effective_events(text) to anon,authenticated;
