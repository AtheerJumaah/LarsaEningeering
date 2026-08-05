-- Audit hardening: pin search_path on the two functions that lacked one.
--
-- Supabase's security advisor flags any function without an explicit
-- search_path, because a caller who can create objects earlier in the path
-- could shadow what the function references. Both bodies use only pg_catalog
-- built-ins, so the empty path changes nothing about behaviour -- it only
-- closes the door. Every other function in this project already sets one.
--
-- Guarded on existence: protect_staff_secrets is created by the base schema,
-- which the local test harness does not replay, and a hardening pass must
-- never be the thing that breaks an environment the function is absent from.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'protect_staff_secrets') then
    alter function public.protect_staff_secrets() set search_path = '';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'acct_unapproved_statuses') then
    alter function public.acct_unapproved_statuses() set search_path = '';
  end if;
end $$;
