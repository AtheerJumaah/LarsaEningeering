-- CAS compares the row's stamp for equality. Every update must advance it,
-- including two writes within one clock tick or a backward clock correction.
create or replace function public.app_state_server_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  else
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
