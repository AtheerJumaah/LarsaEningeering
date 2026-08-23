-- repair_011 — flowConfig machine-seed cleanup (DATA fix, applied 2026-08-23)
--
-- Chains became optional in the app (Approvals: optional chains, rank-based
-- routing, Points review chain). But the shared larsaStaffV8 document still
-- carried an approval chain for every employee, written by the old seeding
-- code, never by a person:
--
--   * the generic seed        {Leave:[u2,u1], Schedule:[u2,u1], Performance:[u6,u1]}
--   * the u6-shaped seed      {Leave:[u1],    Schedule:[u1],    Performance:[u1]}
--   * the u10-shaped seed     {Leave:[u6,u1], Schedule:[u6,u1], Performance:[u6,u1]}
--
-- Those seeds are exactly the "forced chain onto everybody" this repair
-- removes — they hardwired account ids as default approvers and routed the
-- Super Admin's own requests downhill. This migration deletes every
-- flowConfig entry that is BYTE-IDENTICAL to one of the three machine-seed
-- shapes. Any entry a person edited (any deviation at all) is kept whole:
-- in production that kept exactly one employee's hand-configured chains.
--
-- Requests already in flight are untouched — a request keeps the chain it
-- was raised with, by design.
--
-- A safety snapshot of the whole document was inserted into platform_backups
-- first (kind 'manual', created_by 'claude-repair-011'); per the standing
-- production mandate it is never restored automatically.
--
-- Idempotent: re-running removes nothing once the seed-shaped entries are gone.

begin;

insert into platform_backups (kind, label, data, table_counts, byte_size, created_by, mail_status)
select 'manual',
       'pre-repair-011: flowConfig machine-seed cleanup (safety snapshot, not for auto-restore)',
       jsonb_build_object('app_state', jsonb_build_object('store_key', store_key, 'updated_at', updated_at, 'data', data)),
       jsonb_build_object('flowConfig_entries', (select count(*) from jsonb_each(data->'flowConfig'))),
       length(data::text),
       'claude-repair-011',
       'none'
from app_state
where store_key = 'larsaStaffV8'
  and exists (
    select 1 from jsonb_each(data->'flowConfig') k
    where k.value in (
      '{"Leave":["u2","u1"],"Schedule":["u2","u1"],"Performance":["u6","u1"]}'::jsonb,
      '{"Leave":["u1"],"Schedule":["u1"],"Performance":["u1"]}'::jsonb,
      '{"Leave":["u6","u1"],"Schedule":["u6","u1"],"Performance":["u6","u1"]}'::jsonb
    )
  );

update app_state
set data = jsonb_set(
      data,
      '{flowConfig}',
      coalesce((
        select jsonb_object_agg(k.key, k.value)
        from jsonb_each(data->'flowConfig') k
        where k.value not in (
          '{"Leave":["u2","u1"],"Schedule":["u2","u1"],"Performance":["u6","u1"]}'::jsonb,
          '{"Leave":["u1"],"Schedule":["u1"],"Performance":["u1"]}'::jsonb,
          '{"Leave":["u6","u1"],"Schedule":["u6","u1"],"Performance":["u6","u1"]}'::jsonb
        )
      ), '{}'::jsonb)
    ),
    updated_at = now(),
    updated_by = 'repair-011-flowconfig-seed-cleanup'
where store_key = 'larsaStaffV8'
  and exists (
    select 1 from jsonb_each(data->'flowConfig') k
    where k.value in (
      '{"Leave":["u2","u1"],"Schedule":["u2","u1"],"Performance":["u6","u1"]}'::jsonb,
      '{"Leave":["u1"],"Schedule":["u1"],"Performance":["u1"]}'::jsonb,
      '{"Leave":["u6","u1"],"Schedule":["u6","u1"],"Performance":["u6","u1"]}'::jsonb
    )
  );

commit;
