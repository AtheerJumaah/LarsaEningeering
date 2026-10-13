/* STAGING-ONLY ROLLBACK. Never run against production. */
begin;

revoke all on function public.record_attendance_action(
  text, timestamptz, text, text, text, text, text, text, text, text, text[], text, jsonb
) from public, anon, authenticated;
drop function if exists public.record_attendance_action(
  text, timestamptz, text, text, text, text, text, text, text, text, text[], text, jsonb
);
revoke all on function public.current_staff_uid() from public, anon, authenticated;
drop function if exists public.current_staff_uid();
drop trigger if exists attendance_events_no_update on public.attendance_events;
drop trigger if exists staff_auth_identity_touch_updated_at on public.staff_auth_identity;
drop function if exists public.attendance_events_append_only();
drop function if exists public.staff_auth_identity_touch_updated_at();
drop table if exists public.attendance_events;
drop table if exists public.staff_auth_identity;
drop table if exists public.staff_accounts;

commit;
