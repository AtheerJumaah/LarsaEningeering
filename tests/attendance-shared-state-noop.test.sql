begin;
do $$
declare first record; second record;
begin
  select * into first from public.app_state_put('diagnostic-attendance-cas-noop','{"test":1}'::jsonb,null);
  select * into second from public.app_state_put('diagnostic-attendance-cas-noop','{"test":1}'::jsonb,first.current_updated_at);
  if not second.applied or second.current_updated_at is distinct from first.current_updated_at then
    raise exception 'Identical shared document creates another update/realtime echo';
  end if;
  select * into second from public.app_state_put('diagnostic-attendance-cas-noop','{"test":2}'::jsonb,first.current_updated_at);
  if not second.applied or second.current_data->>'test'<>'2' or second.current_updated_at=first.current_updated_at then
    raise exception 'A real edit must still update and advance the server stamp';
  end if;
end $$;
rollback;
