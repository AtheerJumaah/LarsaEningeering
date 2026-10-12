-- Identical documents must not advance stamps and broadcast realtime echoes.
-- Preserve the currently installed CAS, grants, guards, and security mode.
do $$
declare definition text; patched text; marker text;
begin
  select pg_get_functiondef('public.app_state_put(text,jsonb,timestamptz)'::regprocedure) into definition;
  marker := '  return query' || chr(10) || '    update public.app_state a';
  if position('LARSA_IDENTICAL_STATE_NOOP' in definition)>0 then return; end if;
  if position(marker in definition)=0 then raise exception 'Unexpected CAS function; refusing unverified patch'; end if;
  patched := replace(definition, marker,
    '  -- LARSA_IDENTICAL_STATE_NOOP' || chr(10) ||
    '  if cur.data is not distinct from coalesce(p_data, ''{}''::jsonb) then' || chr(10) ||
    '    return query select true, cur.data, cur.updated_at;' || chr(10) ||
    '    return;' || chr(10) ||
    '  end if;' || chr(10) || marker);
  execute patched;
end $$;
