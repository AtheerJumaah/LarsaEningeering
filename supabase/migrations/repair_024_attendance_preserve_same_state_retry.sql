-- Preserve the latest attendance snapshot query and acknowledge an already
-- satisfied action before validating the chronology of a new ledger record.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb)'::regprocedure);
  chronology_start integer := strpos(definition, '  -- An uncertain retry must never silently become a punch at reconnection.');
  same_state_start integer := strpos(definition, '  if v_current.status=p_status then');
  break_check_start integer := strpos(definition, '  if p_status=''Break Start''');
begin
  if chronology_start > same_state_start and same_state_start > 0 and break_check_start > chronology_start then
    return;
  end if;
  if chronology_start <= 0 or same_state_start <= chronology_start or break_check_start <= same_state_start then
    raise exception 'Unexpected attendance function; cannot restore the same-state retry order';
  end if;

  execute substr(definition, 1, chronology_start - 1)
    || substr(definition, same_state_start, break_check_start - same_state_start)
    || substr(definition, chronology_start, same_state_start - chronology_start)
    || substr(definition, break_check_start);
end;
$migration$;
