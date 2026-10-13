# Attendance staging bootstrap — blocked pending a reviewed identity baseline

**Status:** design/review artifact only. No SQL was applied in this block. No production state was touched.  
**Target reviewed:** `hevpiozjxzsftidwflki` (`Larsa Engineering Staging`).  
**Current staging state:** the earlier safe bootstrap contains `app_state` and additive accounting tables only; it does not contain `staff_accounts`, `user_verification`, `auth_policy`, `staff_auth_identity`, `attendance_events`, or an identity-authorized attendance RPC.

## Decision

Do not create or apply an attendance bootstrap migration yet. A complete synthetic-safe attendance schema cannot be derived from the repository without inventing missing table contracts and authorization behavior. Applying the existing attendance repair files would create a behaviorally testable writer, but it would not create server-authenticated employee attendance and would normalize the current production security gap in staging.

## Dependency audit

| Required capability | Repository evidence | Safe conclusion |
|---|---|---|
| `app_state` baseline | `supabase/schema.sql` | Available and already staged. The file defines only `public.app_state`. |
| `staff_accounts` ledger | `repair_007_durable_account_ledger.sql` | A durable account ledger definition exists, but its RPCs accept client-supplied account JSON and are not an Auth-to-staff authorization model. It cannot be treated as the identity-binding prerequisite. |
| `user_verification` | Only altered by `repair_003...`; consumed by `supabase/functions/auth-policy` | No canonical `CREATE TABLE` definition exists in the repository. Columns, keys, and RLS cannot be safely inferred from ALTER statements and application reads alone. |
| `auth_policy` | Altered by `20260805_auth_026_pin_verification_policy.sql` and `repair_003...`; consumed by `supabase/functions/auth-policy` | No canonical base definition exists. Applying the ALTER migrations to a blank project would fail or require speculative columns/constraints. |
| `platform_admins` / `auth_codes` | Referenced by `acct_002` and Edge Functions; only test shims define them | Test shims are not a production/staging schema contract and must not be promoted into an application migration without review. |
| `attendance_events` | Created by `repair_002_durable_attendance_ledger_and_write_hardening.sql` | This is a production incident repair. Its policy permits any `authenticated` session, and the table has no staff/Auth mapping. It is not sufficient for strict identity tests. |
| `record_attendance_action` | Created/replaced by `repair_014_attendance_chronology_audit.sql` | The current body accepts client `p_uid`/`p_actor_employee_id`, uses `auth.uid()` only as audit metadata, and grants execution to `anon` and `authenticated`. This is explicitly a Gate B/NO-GO path, not a safe identity bootstrap. |
| `staff_auth_identity` / `current_staff_uid()` | Required by `tests/red/attendance-identity-binding.red.sql` | Neither exists in the repository migrations. The red contract intentionally fails until an approved shadow mapping and server helper are designed. |

## Existing migrations that must remain blocked

- `repair_002_durable_attendance_ledger_and_write_hardening.sql`: creates the ledger but leaves employee identity unauthenticated and changes app-state write grants.
- `repair_012_atomic_attendance_punch.sql`: creates an older In/Out writer and grants it to `anon`/`authenticated`; it is not the current strict writer contract.
- `repair_014_attendance_chronology_audit.sql`: adds useful audit columns and Break actions but retains client-controlled employee identity and broad RPC grants.
- `repair_016_attendance_effective_corrections.sql`, `repair_017_attendance_same_intent_race.sql`, and `repair_020_retire_legacy_attendance_writer.sql`: depend on the preceding attendance repair chain and change writer/policy behavior.
- `repair_007_durable_account_ledger.sql`, `repair_008_server_guard_stale_writes.sql`, and `repair_003_verification_keyed_to_email_and_interval_units.sql`: require missing base tables and/or data contracts; they are not blank-project bootstrap files.

No migration in the chain currently provides the minimum safe invariant:

```text
auth.uid() → approved staff_auth_identity mapping → enabled staff record/scope
          → server-derived actor/target → append-only attendance event
```

## Required reviewed bootstrap, before any apply

The next artifact must be a newly approved staging-only migration (not a repurposed incident repair) with explicit contracts for:

1. Synthetic `staff_accounts` rows and a separate `staff_auth_identity` table keyed by Auth UUID, with uniqueness and RLS.
2. Canonical synthetic definitions for `user_verification`, `auth_policy`, `platform_admins`, and `auth_codes`, or an explicit decision that those unrelated sign-in/accounting tables are out of scope for attendance staging.
3. `current_staff_uid()` or equivalent server helper that rejects anonymous, unmapped, disabled, offboarded, and deleted Auth identities.
4. An authoritative attendance RPC deriving actor identity from `auth.uid()`, checking self/manager scope, preserving event ID/time, and allowing no direct attendance table writes.
5. Synthetic-only fixtures; no production IDs, emails, Auth UUIDs, credentials, rows, or screenshot evidence.
6. An isolated rollback plan and pre/post snapshots for tables, RLS, policies, function security/search paths, grants, and extensions.

## Required tests before Gate B apply

The existing synthetic fixture and red contracts are the acceptance starting point:

- `tests/fixtures/attendance-identity-fixtures.mjs`
- `tests/red/attendance-identity-binding.red.sql`
- `tests/red/attendance-identity-binding.red.test.mjs`
- `tests/attendance-runtime.test.mjs`
- `tests/attendance-queue-runtime.test.mjs`
- `tests/attendance-browser.smoke.mjs`
- `tests/red/attendance-strict-browser.red.mjs`
- `tests/atomic-attendance-punch-sql.test.sql`
- `tests/attendance-production-transaction.test.sql` — rollback-only, isolated fixture database only; never run against this staging target until its prerequisites are reviewed.

The SQL gate must prove mapped self success; anonymous/unmapped/disabled/mismatched denial; manager in-scope success; manager out-of-scope denial; server-derived actor; stable idempotency; chronology and original-time preservation; append-only behavior; no direct INSERT grant; and rollback with zero residual fixture rows.

## Next safe gate

Keep the attendance bootstrap **NO-GO**. Engineering may prepare the reviewed schema contract and synthetic SQL tests locally. Do not apply `repair_002`, `repair_012`, `repair_014`, or any identity/grant migration to staging until the missing base contracts and server-authoritative mapping are approved. Production remains unchanged.
