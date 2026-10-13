# Staging-only Supabase migration allowlist

Read-only audit of `supabase/migrations/` for a new blank, non-production Supabase project. This is an allowlist for review and staging preparation, not an instruction to apply migrations to production. No migration, grant, row, Auth user, secret, cron job, or external integration was changed during this audit.

## Decision

There is no unconditional copy/paste allowlist for a truly blank project. The repository does not contain a single base-schema migration for the pre-existing `app_state`, `staff_accounts`, `user_verification`, `auth_policy`, `platform_admins`, `auth_codes`, and related tables that several files alter. First create or restore a **synthetic-only staging base schema** and verify it with a schema preflight. Then apply only the ordered, dependency-complete subset below.

## A. Safe staging schema/function definitions (synthetic staging only)

These are additive or hardening definitions when their documented prerequisites exist. They still need ordinary SQL compile and privilege-diff checks; “safe” does not mean production-approved.

| Migration | Staging disposition |
|---|---|
| `20260801_acct_001_core_tables.sql` | Allow after base-schema preflight; creates accounting tables/extensions and a singleton platform-settings seed. Use no real identities/data. |
| `20260801_acct_002_engine_functions.sql` | Allow function/table definitions after 001 and base auth-code prerequisites. Do not invoke mutating RPCs during migration. |
| `20260801_acct_003_summary_refund.sql` | Allow function definitions after 001–002; exercise only with synthetic fixtures. |
| `20260801_acct_004_protected_sample_legacy.sql` | Allow definitions only. Do not call sample seeding, legacy import, reset, restore, void, or destructive workflow functions as part of bootstrap. |
| `20260801_acct_005_pin_search_paths.sql` | Allow only after its target functions exist; hardening-only. |
| `20260802_acct_007_maker_checker.sql` | Allow definitions after the accounting base; test with synthetic actors and approval rows. |
| `20260802_acct_008_authoritative_financials.sql` | Allow definitions after accounting base; synthetic fixtures only. |
| `20260803_acct_009_payroll.sql` | Allow additive payroll schema/functions after accounting base; synthetic employee/pay-period fixtures only. |
| `20260803_acct_010_payroll_portal.sql` | Allow function definitions after 009; synthetic actors only. |
| `20260803_acct_015_waiver_reason.sql` | Allow function definition after the fee-rule prerequisite. |
| `20260803_notify_011_center.sql` | Allow notification schema plus non-sensitive category seed rows; no real recipients or subscriptions. |
| `20260804_audit_021_search_path.sql` | Allow hardening blocks only when each guarded function exists; otherwise skip the guarded block, do not fabricate production functions. |
| `repair_002b_ledger_break_statuses.sql` | Allow the status constraint on a synthetic attendance table after schema preflight; verify fixtures before enforcing. |
| `repair_006_pin_trigger_search_path.sql` | Allow trigger hardening after the append-only attendance trigger exists. |
| `repair_015_attendance_writer_audit.sql` | Allow only with synthetic attendance/app-state fixtures and trigger tests; this changes receipt metadata on future staging inserts. |
| `repair_018_attendance_effective_query_cost.sql` | Allow only after 016/017 function-shape preflight passes; it is a function replacement, not a standalone blank-schema migration. |
| `repair_019_shared_state_noop.sql` | Allow only after `app_state_put(text,jsonb,timestamptz)` precondition and function-body marker check pass. |

`20260802_acct_006_review_receipts_permissions.sql` is mixed: its table/function definitions may be staged, but its data normalization and grants belong in the permission/data review below. Do not treat the file as unconditionally safe.

## B. Gate B: identity, attendance policy, RLS, or privilege changes

These require explicit approval, a synthetic Auth-to-staff mapping, policy diff, rollback SQL, and behavioral tests before any production use. They are not part of the default staging bootstrap allowlist.

| Migration | Why gated |
|---|---|
| `20260803_acct_016_viewer_accounts.sql` | Adds Auth-linked viewer identity, RLS, account guards, and lifecycle behavior. |
| `20260803_acct_017_viewer_accounts_hardening.sql` | Revokes/grants viewer RPC execution and narrows access. |
| `20260803_acct_018_viewer_portal.sql` | Adds viewer-scoped read RPC and authenticated execution. |
| `20260804_acct_020_viewer_sections.sql` | Adds viewer section RLS and write RPCs. |
| `20260804_audit_022_viewer_rpc_isolation.sql` | Changes direct accounting RPC access for viewer identities. |
| `20260805_audit_023_viewer_accounts_read_recursion.sql` | Replaces viewer RLS and table grants. |
| `20260805_auth_026_pin_verification_policy.sql` | Changes sign-in verification policy and interval behavior. |
| `20260806_acct_021_admin_role_parity.sql` | Expands database role capabilities and permission defaults. |
| `20260806_sync_001_app_state_server_time.sql` | Replaces shared-state write behavior and function grants. |
| `repair_002_durable_attendance_ledger_and_write_hardening.sql` | Creates the attendance ledger, RLS, append-only triggers, CAS path, and direct-write revocations. |
| `repair_007_durable_account_ledger.sql` | Adds staff-account identity backstop, no-delete behavior, and writer functions. |
| `repair_008_server_guard_stale_writes.sql` | Adds server-side stale-write guards and account upsert behavior. |
| `repair_009_attendance_ledger_anon_access.sql` | Explicitly opens anonymous attendance SELECT/INSERT policy; **NO-GO** for production until Gate B authorization is approved. |
| `repair_012_atomic_attendance_punch.sql` | Replaces attendance transition RPC and its execution privileges. |
| `repair_014_attendance_chronology_audit.sql` | Adds actor/auth audit columns and grants `record_attendance_action` to anon/authenticated; **NO-GO** for production as currently authored. |
| `repair_016_attendance_effective_corrections.sql` | Adds effective-time reconstruction and client-facing grants. |
| `repair_017_attendance_same_intent_race.sql` | Patches the authoritative attendance function by body-shape assertion. |
| `repair_020_retire_legacy_attendance_writer.sql` | Drops/recreates the legacy writer and changes execution privileges. |
| `20260801_acct_006_review_receipts_permissions.sql` | Mixed file: RLS/table grants and dynamic permission revocation require a separate privilege diff. |
| `20260803_notify_014_dispatch.sql` | Creates `pg_net`/`pg_cron`, service-role execution, and external dispatch configuration. Stage only with isolated stubs/secrets. |
| `20260804_notify_019_email_channel.sql` | Changes notification RLS and service/authenticated execution paths; stage without real mail/push credentials. |

## C. Data repairs/cleanup — synthetic fixtures only, never bootstrap blindly

| Migration | Disposition |
|---|---|
| `repair_003_verification_keyed_to_email_and_interval_units.sql` | Data backfill/update of verification rows; requires synthetic duplicate/missing-email fixtures and before/after assertions. |
| `repair_011_flowconfig_seed_cleanup.sql` | Deletes/re-writes seeded workflow state in `app_state`; do not run against production or an unreviewed staging dataset. |
| `20260802_acct_006_review_receipts_permissions.sql` | Contains an `acct_transactions` update and sample/data lifecycle logic in addition to schema/grants; split or review before staging. |

## D. Production-only / excluded from staging allowlist

| Migration | Reason |
|---|---|
| `repair_001_full_backup_before_incident_repair.sql` | Copies every public table and an Auth projection into a private backup schema; production incident backup, not blank-staging setup. |
| `repair_004_incident_recovery_aug6.sql` | One-time incident recovery/backfill of historical production identities and ledger rows. |
| `repair_005_incident_recovery_merge_proof.sql` | One-time merge-proof recovery with historical replacement/tombstone rows. |
| `repair_008a_safety_snapshot_20260822.sql` | Emergency snapshot of live tables before a production guard; never automatic restore. |

## Required staging gates before any apply

1. Confirm the project is non-production, empty/synthetic, and has no real employee PII, Auth users, tokens, mail, push, `pg_net`, or cron secrets.
2. Materialize and version the missing base schema first; fail closed if a referenced table/function/signature is absent.
3. Apply in filename order; never cherry-pick a repair file around its precondition.
4. Capture pre/post schema, policy, RLS, grants, function security/search paths, and extensions; the diff must be reviewed.
5. Run synthetic SQL tests for idempotency, chronology, RLS, actor binding, account switching, rollback, and denied/expired attendance recovery.
6. Production remains **NO-GO** for `repair_009`, the current `repair_014` anonymous/authenticated grants, direct attendance grants, Auth mapping, and any data-repair/backup migration until explicit Gate B approval.
