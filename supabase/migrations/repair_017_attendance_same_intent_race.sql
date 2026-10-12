-- Two devices selecting the SAME state can arrive out of timestamp order.
-- A state already satisfied needs no insert or historical timestamp rewrite.
do $$
declare definition text; patched text; a int; b int; c int;
begin
  select pg_get_functiondef('public.record_attendance_action(text,timestamptz,text,text,text,text,text,text,text,text,text[],text,jsonb)'::regprocedure) into definition;
  a:=strpos(definition,'  if p_occurred_at <');
  b:=strpos(definition,'  if v_current.status=p_status then');
  c:=strpos(definition,'  if p_status=''Break Start''');
  if a<=0 or b<=a or c<=b then raise exception 'Unexpected attendance function; refusing unverified edit'; end if;
  patched:=substr(definition,1,a-1)||substr(definition,b,c-b)||substr(definition,a,b-a)||substr(definition,c);
  execute patched;
end $$;
