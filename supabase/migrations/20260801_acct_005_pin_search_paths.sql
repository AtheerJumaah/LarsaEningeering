-- Pin search_path on the small helper functions (advisor hygiene).
alter function public.acct_audit_block_mutation() set search_path = public, pg_temp;
alter function public.acct_touch_updated_at() set search_path = public, pg_temp;
alter function public.acct_writer_roles() set search_path = public, pg_temp;
alter function public.acct_check_actor(jsonb, text) set search_path = public, pg_temp;
alter function public.acct_fee_eligible(text, text, jsonb) set search_path = public, pg_temp;
alter function public.acct_fee_postable(text, text) set search_path = public, pg_temp;
alter function public.acct_actual_statuses(text) set search_path = public, pg_temp;
