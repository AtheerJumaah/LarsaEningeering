-- Advisor follow-up: pin the append-only trigger's search_path (it takes no
-- schema-dependent action, but a pinned path removes the lint and the risk
-- class entirely).
create or replace function public.attendance_events_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'attendance_events is append-only: % is not permitted', tg_op;
end $$;
