# Staging attendance identity contract run

Status: staging-only PASS; production remains NO-GO.

Date: 2026-10-13

Target: Supabase project `hevpiozjxzsftidwflki` (Larsa Engineering Staging).

Applied migration: `staging_attendance_identity_contract`, remote version
`20261013135400`. The SQL source is
[`supabase/staging/attendance_identity_contract.sql`](../supabase/staging/attendance_identity_contract.sql).
This file is deliberately outside `supabase/migrations` so it cannot be
picked up by a normal production migration push.

## Contract installed

- `staff_auth_identity` is a unique Auth UUID -> staff UID mapping, with an
  enabled flag, employee/manager role, and explicit manager team scope.
- Only enabled, non-offboarded mapped users can act. Employees are self-only;
  managers can target only enabled staff whose `team_id` is in their mapped
  `manager_team_ids`.
- `attendance_events` is RLS-enabled and forced-RLS, has no `anon`,
  `authenticated`, or `public` table grants, and has an update/delete blocker
  trigger. All writes cross `record_attendance_action`.
- The RPC is the only client-executable attendance writer and derives
  `auth_session_id`, `actor_employee_id`, `clocked_by`, name, and normalized
  email from the authenticated mapping/staff row. Client-supplied actor and
  display fields are not authority inputs.
- `client_event_id` is unique and duplicate retries return `already`; a
  per-staff advisory lock closes same-target races. `occurred_at` is preserved
  and older-than-current events return `22023` for review.
- Reserved synthetic fixtures only: six `.test` staff rows and two reserved
  Auth UUID mappings. No `auth.users` rows, sessions, credentials, or real
  employee identifiers were created.

## Verification evidence

- Migration list contains only the two previously approved staging migrations
  plus `staging_attendance_identity_contract`.
- `staff_accounts`, `staff_auth_identity`, and `attendance_events` all report
  `relrowsecurity=true` and `relforcerowsecurity=true`.
- Role table grants for `anon`, `authenticated`, and `public` are empty for
  all three contract tables.
- Routine privileges show only `authenticated EXECUTE` on
  `record_attendance_action`; `current_staff_uid` and append-only triggers are
  not client-executable.
- Policies are intentionally absent: with forced RLS and no table grants,
  direct client reads/writes fail closed. Supabase security advisor reports
  the expected `rls_enabled_no_policy` INFO findings for these three tables.
- Synthetic transactional smoke passed and rolled back with zero attendance
  rows remaining: self In, duplicate retry, Out, stale chronology denial,
  manager in-scope write, manager out-of-scope denial, and unmapped identity
  denial. Server-derived display/audit fields were checked inside the rolled
  back transaction.
- Local focused suite: 55/55 passed, including the new static contract tests.

## Rollback snapshot and command outline

Before any future staging change, capture read-only snapshots:

```sql
select count(*) as staff_count from public.staff_accounts;
select count(*) as identity_count from public.staff_auth_identity;
select count(*) as attendance_count from public.attendance_events;
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public'
  and c.relname in ('staff_accounts','staff_auth_identity','attendance_events');
```

If staging-only rollback is approved, run
[`supabase/staging/attendance_identity_contract_rollback.sql`](../supabase/staging/attendance_identity_contract_rollback.sql)
against this staging project only, then verify the objects and snapshots are
absent. Do not run it against production or a shared database.

## Production blockers / NO-GO

- No real Auth-to-staff mapping has been approved or enrolled. Atheer/HR must
  approve the canonical staff roster, email collision handling, offboarding
  semantics, manager scope source, and privacy retention policy.
- Production Auth UUIDs must be reconciled by an approved, auditable process;
  this staging fixture is not evidence for production enrollment.
- Gate B must approve a production migration chain and a backup/snapshot,
  direct-table grant revocation, RPC rollout, compatibility-flag cutover, and
  rollback rehearsal. The existing `repair_002`, `repair_012`, `repair_014`,
  `repair_016`, `repair_017`, and `repair_020` files remain unapproved for
  production and were not applied here.
- The expected advisor warning that an authenticated user can execute the
  security-definer RPC is intentional for this RPC boundary; it must remain
  narrowly scoped, search-path pinned, identity-checked, and the only write
  capability. Existing unrelated staging warnings for `rls_auto_enable`,
  `acct_audit_block_mutation`, and `acct_touch_updated_at` remain unchanged.
- No preview or production deployment is authorized by this block.
