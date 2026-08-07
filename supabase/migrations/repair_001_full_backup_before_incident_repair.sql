-- LARSA incident repair, step 0: complete point-in-time backup of EVERY
-- public table plus the auth.users projection, into a dedicated schema no
-- client role can touch. Exact rows, exact timestamps, duplicates and
-- orphans preserved. Nothing is deleted or modified by this migration.
do $$
declare
  t record;
begin
  execute 'create schema if not exists larsa_backup_20260807';
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('create table if not exists larsa_backup_20260807.%I as table public.%I', t.tablename, t.tablename);
  end loop;
  execute 'create table if not exists larsa_backup_20260807.auth_users as select id, email, created_at, updated_at, last_sign_in_at, email_confirmed_at, raw_user_meta_data, is_anonymous from auth.users';
end $$;
revoke all on schema larsa_backup_20260807 from anon, authenticated;
revoke all on all tables in schema larsa_backup_20260807 from anon, authenticated;
