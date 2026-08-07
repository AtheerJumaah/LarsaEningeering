-- Recovery, second pass — MERGE-PROOF this time. The first pass edited uid
-- fields in place; within a minute an open client's three-way merge (which
-- lets the device win on same-id conflicts) pushed the old state back. So
-- this pass never edits contested records: it REMOVES the orphaned records
-- (tombstoned in removedLogIds so ledger reconciliation honours the removal)
-- and ADDS replacement records under NEW ids ("<old>:r1") carrying the
-- recovered identity plus the full original evidence (origId, origUid,
-- original timestamps). A stale client's merge sees only: records it also
-- has that the server deleted (dropped, because its base has them too), and
-- brand-new server records it has never seen (kept). Both sides converge on
-- the recovery instead of reverting it.
--
-- Identity evidence (account_lifecycle_audit, user_verification,
-- platform_backups, pre-reset archive):
--   u9  = Ahmed Asaad    (audit 2026-08-06 17:00 names u9; recreated as u14)
--   u27 = Yasser Mohammed (pre-reset u27 carried ymohammed@ = current u2)
--   u10 pre-18:30 Aug 6 = Maryam Raad (audits 15:19/15:21; now u18)
--   u11, u12 = UNRESOLVED -> flagged needs-review, preserved, never guessed
--   u6 In 2026-08-05T10:58:16.991Z restored from the Aug 5 platform backup
do $$
declare
  attempt int;
  v_stamp timestamptz;
  v_logs jsonb;
  v_new jsonb;
  v_removed jsonb;
  v_hany jsonb;
  rows_hit int;
begin
  for attempt in 1..6 loop
    select updated_at, data->'logs', coalesce(data->'removedLogIds','[]'::jsonb)
      into v_stamp, v_logs, v_removed
      from app_state where store_key = 'larsaStaffV8';

    select coalesce(jsonb_agg(
      l || jsonb_build_object(
        'id', (l->>'id') || ':r1',
        'uid', case when l->>'uid' = 'u9' then 'u14'
                    when l->>'uid' = 'u27' then 'u2'
                    when l->>'uid' = 'u10' then 'u18' end,
        'origId', l->>'id',
        'origUid', l->>'uid',
        'recovery', 'incident-20260806',
        'note', case when coalesce(l->>'note','') = '' then
                  case when l->>'uid' = 'u9'  then 'Recovered: recorded under vanished account u9 (same person — Ahmed Asaad)'
                       when l->>'uid' = 'u27' then 'Recovered: recorded under pre-reset account u27 (same person — Yasser Mohammed, matched by email)'
                       else 'Recovered: recorded while u10 was Maryam Raad''s account (audit-verified)' end
                else (l->>'note') || ' · Recovered from the Aug 6 incident' end)
      order by l->>'time'), '[]'::jsonb)
    into v_new
    from jsonb_array_elements(v_logs) l
    where (l->>'uid' = 'u9' or l->>'uid' = 'u27'
           or (l->>'uid' = 'u10' and l->>'time' in ('2026-08-06T13:51:07.610Z','2026-08-06T13:51:15.373Z')))
      and coalesce(l->>'recovery','') = '';

    select to_jsonb(l) || jsonb_build_object(
        'recovery','backup-restore',
        'note','Recovered from the Aug 5 platform backup: this clock-in was overwritten out of the shared state during the incident')
    into v_hany
    from platform_backups pb,
         jsonb_array_elements(pb.data->'tables'->'app_state') row_j,
         jsonb_array_elements(row_j->'data'->'logs') l
    where pb.id = '25b89d7f-9033-405d-a030-9c7b3752b0ac'
      and row_j->>'store_key' = 'larsaStaffV8'
      and l->>'id' = 'l1785927496991';

    select jsonb_agg(
      case when l->>'uid' in ('u11','u12') and coalesce(l->>'recovery','') = '' then
        l || jsonb_build_object('recovery','needs-review',
          'note', case when coalesce(l->>'note','') = '' then 'Needs review: recorded under an account that vanished in the Aug 6 incident; identity could not be proven from backups — see the Incident Recovery Report'
                  else (l->>'note') || ' · Needs review: identity unproven, see the Incident Recovery Report' end)
      else l end order by ord)
    into v_logs
    from jsonb_array_elements(v_logs) with ordinality as t(l, ord)
    where not ((l->>'uid' = 'u9' or l->>'uid' = 'u27'
                or (l->>'uid' = 'u10' and l->>'time' in ('2026-08-06T13:51:07.610Z','2026-08-06T13:51:15.373Z')))
               and coalesce(l->>'recovery','') = '');

    v_logs = coalesce(v_logs, '[]'::jsonb) || v_new;
    if v_hany is not null and not exists (
      select 1 from jsonb_array_elements(v_logs) l where l->>'id' = 'l1785927496991') then
      v_logs = v_logs || jsonb_build_array(v_hany);
    end if;

    select v_removed || coalesce(jsonb_agg(to_jsonb(l->>'id')), '[]'::jsonb)
    into v_removed
    from (select jsonb_array_elements((select data->'logs' from app_state where store_key='larsaStaffV8')) l) s(l)
    where (l->>'uid' = 'u9' or l->>'uid' = 'u27'
           or (l->>'uid' = 'u10' and l->>'time' in ('2026-08-06T13:51:07.610Z','2026-08-06T13:51:15.373Z')))
      and coalesce(l->>'recovery','') = '';

    update app_state
       set data = jsonb_set(jsonb_set(data, '{logs}', v_logs), '{removedLogIds}', v_removed),
           updated_by = 'incident-recovery repair_005'
     where store_key = 'larsaStaffV8' and updated_at = v_stamp;
    get diagnostics rows_hit = row_count;
    exit when rows_hit = 1;
    perform pg_sleep(0.4);
  end loop;

  if rows_hit <> 1 then
    raise exception 'could not win the CAS after 6 attempts — rerun this migration';
  end if;
end $$;

insert into attendance_events (client_event_id, occurred_at, uid, normalized_email, person_name, status, work_mode, note, clocked_by, source)
select
  l->>'id', (l->>'time')::timestamptz, l->>'uid',
  (select nullif(trim(lower(u->>'email')),'') from app_state a2, jsonb_array_elements(a2.data->'users') u
    where a2.store_key='larsaStaffV8' and u->>'id' = l->>'uid' limit 1),
  (select u->>'name' from app_state a2, jsonb_array_elements(a2.data->'users') u
    where a2.store_key='larsaStaffV8' and u->>'id' = l->>'uid' limit 1),
  l->>'status', l->>'type', l->>'note', l->>'clockedBy', 'incident-recovery'
from app_state a, jsonb_array_elements(a.data->'logs') l
where a.store_key = 'larsaStaffV8'
  and (l->>'recovery') in ('incident-20260806','backup-restore')
  and (l->>'status') in ('In','Out','Break Start','Break End')
on conflict (client_event_id) do nothing;
