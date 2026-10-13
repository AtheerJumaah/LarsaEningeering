-- Retire the pre-repair attendance writer without deleting history.
--
-- The current application calls record_attendance_action.  Older bundles can
-- still call attendance_punch, though, and that SECURITY DEFINER function used
-- a separate receipt-time state machine.  Keeping two writers means an old
-- client can bypass the repaired chronology/audit path.  Keep the signature
-- for compatibility, but make it an invoker wrapper around the authoritative
-- operation and remove anonymous execution.  Anonymous Auth sessions use the
-- authenticated Postgres role after signInAnonymously(), which is the same
-- path used by the current app.

drop function if exists public.attendance_punch(text,text,text,text,text,text,text[]);

create function public.attendance_punch(
  p_client_event_id text,
  p_uid text,
  p_status text,
  p_work_mode text default null,
  p_note text default null,
  p_source text default 'app',
  p_ignored_event_ids text[] default '{}'
)
returns table(
  applied boolean,
  client_event_id text,
  occurred_at timestamptz,
  current_status text,
  work_mode text,
  reason text
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v record;
begin
  select * into v
  from public.record_attendance_action(
    p_client_event_id,
    clock_timestamp(),
    p_uid,
    null,
    null,
    p_status,
    p_work_mode,
    p_note,
    null,
    coalesce(nullif(trim(p_source), ''), 'legacy-attendance-punch'),
    coalesce(p_ignored_event_ids, '{}'),
    null,
    null
  );

  return query select
    (v.outcome = 'recorded'),
    v.event_id,
    v.current_at,
    v.current_status,
    v.current_work_mode,
    v.outcome;
end;
$$;

revoke all on function public.attendance_punch(text,text,text,text,text,text,text[])
  from public, anon;
grant execute on function public.attendance_punch(text,text,text,text,text,text,text[])
  to authenticated;

