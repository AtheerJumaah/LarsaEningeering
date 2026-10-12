-- The immutable ledger preserves original events. Approved in-place trims in
-- app_state are the effective times, and must also drive current-state checks.
create or replace function public.attendance_effective_events(p_uid text)
returns setof public.attendance_events language sql stable security invoker
set search_path=pg_catalog,public as $$
  with corrected as (
    select coalesce(jsonb_object_agg(l->>'id',l->>'time'),'{}'::jsonb) as times
    from public.app_state s,
      lateral jsonb_array_elements(coalesce(s.data->'logs','[]'::jsonb)) l
    where s.store_key='larsaStaffV8' and l->>'uid'=p_uid and l->>'id' is not null
  )
  select (jsonb_populate_record(e,
    case when pg_input_is_valid(c.times->>e.client_event_id,'timestamptz')
      then jsonb_build_object('occurred_at',c.times->>e.client_event_id)
      else '{}'::jsonb end)).*
    from public.attendance_events e cross join corrected c where e.uid=p_uid;
$$;
revoke all on function public.attendance_effective_events(text) from public;
grant execute on function public.attendance_effective_events(text) to anon,authenticated;
do $$
declare definition text; patched text;
begin
  select pg_get_functiondef('public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb)'::regprocedure) into definition;
  patched := replace(definition, 'from public.attendance_events e' || chr(10) || '    where e.uid=p_uid',
    'from public.attendance_effective_events(p_uid) e' || chr(10) || '    where e.uid=p_uid');
  if patched=definition then raise exception 'Unexpected attendance function definition; refusing an unverified patch'; end if;
  execute patched;
end $$;
