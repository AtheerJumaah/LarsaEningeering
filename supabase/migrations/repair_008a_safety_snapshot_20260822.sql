-- Emergency safety snapshot taken immediately before repair_008 (the
-- server-side document guard) went live: exact copies of every table that
-- repair touches or reads, in a schema no client role can reach.
--
-- This is an insurance copy ONLY. It must never be restored automatically,
-- and restoring it wholesale would violate the repair's own ground rule —
-- the live system is the source of truth, not any backup. It exists so
-- that if the guard misbehaved in a way every test missed, individual
-- values could be compared and repaired forward, without ever rolling the
-- database back over newer legitimate writes.
do $$
begin
  execute 'create schema if not exists larsa_backup_20260822';
  execute 'create table if not exists larsa_backup_20260822.app_state as table public.app_state';
  execute 'create table if not exists larsa_backup_20260822.staff_accounts as table public.staff_accounts';
  execute 'create table if not exists larsa_backup_20260822.attendance_events as table public.attendance_events';
  execute 'create table if not exists larsa_backup_20260822.user_verification as table public.user_verification';
  execute 'create table if not exists larsa_backup_20260822.auth_policy as table public.auth_policy';
  execute 'create table if not exists larsa_backup_20260822.platform_admins as table public.platform_admins';
end $$;
revoke all on schema larsa_backup_20260822 from anon, authenticated;
revoke all on all tables in schema larsa_backup_20260822 from anon, authenticated;
