# Staging migration run — `hevpiozjxzsftidwflki`

**Run date:** 2026-10-13 UTC  
**Target:** Supabase project `hevpiozjxzsftidwflki` (`Larsa Engineering Staging`, `ap-south-1`)  
**Safety scope:** staging only; no production project, grants, rows, Auth users, or deployments were touched.

## Preflight

The project was `ACTIVE_HEALTHY`, had no recorded migrations, and had no public application tables before this run. The repository has a legacy baseline at `supabase/schema.sql`, but it is not a timestamped migration and creates only `public.app_state`; it does not define the staff, Auth-policy, or attendance tables referenced by later migrations.

## Applied

| Remote version | Source | Result |
|---|---|---|
| `20261013132455` / `staging_base_app_state` | `supabase/schema.sql` | Applied as the synthetic baseline. Creates `public.app_state`, its RLS policy, realtime publication entry, and three empty localStorage-key rows. |
| `20261013132524` / `20260801_acct_001_core_tables` | `supabase/migrations/20260801_acct_001_core_tables.sql` | Applied. Additive accounting tables, indexes, triggers, RLS, and read-only client table grants only; no sample/data lifecycle or accounting writes were invoked. |

## Verification after apply

- 11 public tables; RLS enabled on all 11.
- Rows: `app_state` = 3 baseline keys; `acct_platform_settings` = 1 singleton; all other accounting tables = 0.
- Public functions: `acct_audit_block_mutation`, `acct_touch_updated_at`, and the pre-existing platform helper `rls_auto_enable`; no accounting client RPCs from `acct_002` were installed.
- Accounting tables have `SELECT` grants for `anon` and `authenticated`; direct `INSERT`, `UPDATE`, and `DELETE` are revoked. `app_state` has no explicit client `SELECT` grant yet, so app sync is not considered staging-ready.
- Security advisor findings: the two new trigger helpers have mutable search paths, and the pre-existing `public.rls_auto_enable()` is `SECURITY DEFINER` executable by `anon`/`authenticated`. These were recorded, not broadened or repaired in this bounded run.
- Performance advisors reported expected unused indexes on an empty staging database and RLS init-plan notices; no production inference was made.

## Skipped migrations

The following repository migrations were not applied. Every omission is deliberate and remains pending review:

### Safe candidates omitted because they are not required for the smallest staging schema

- `20260801_acct_002_engine_functions.sql` — depends on absent `platform_admins` and `auth_codes` base tables; also installs accounting RPCs.
- `20260801_acct_003_summary_refund.sql` — depends on `acct_002` functions.
- `20260801_acct_004_protected_sample_legacy.sql` — sample/import/reset lifecycle functions; not needed for an empty synthetic project.
- `20260801_acct_005_pin_search_paths.sql` — depends on functions from `acct_002`.
- `20260802_acct_007_maker_checker.sql` — optional accounting approval schema.
- `20260802_acct_008_authoritative_financials.sql` — optional accounting hardening.
- `20260803_acct_009_payroll.sql` — optional payroll schema.
- `20260803_acct_010_payroll_portal.sql` — depends on payroll and Auth/account context.
- `20260803_acct_015_waiver_reason.sql` — optional accounting extension.
- `20260803_notify_011_center.sql` — optional notification schema/category seed.
- `20260804_audit_021_search_path.sql` — hardening only; guarded functions were not all present.
- `repair_002b_ledger_break_statuses.sql` — attendance table is not in the safe baseline.
- `repair_006_pin_trigger_search_path.sql` — attendance/PIN trigger prerequisite absent.
- `repair_015_attendance_writer_audit.sql` — attendance writer prerequisite absent.
- `repair_018_attendance_effective_query_cost.sql` — requires later attendance function shapes.
- `repair_019_shared_state_noop.sql` — requires the later `app_state_put` signature.

### Mixed, identity, policy, grant, or external-service changes held for Gate B

- `20260802_acct_006_review_receipts_permissions.sql`
- `20260803_acct_016_viewer_accounts.sql`
- `20260803_acct_017_viewer_accounts_hardening.sql`
- `20260803_acct_018_viewer_portal.sql`
- `20260803_notify_014_dispatch.sql`
- `20260804_acct_020_viewer_sections.sql`
- `20260804_audit_022_viewer_rpc_isolation.sql`
- `20260804_notify_019_email_channel.sql`
- `20260805_audit_023_viewer_accounts_read_recursion.sql`
- `20260805_auth_026_pin_verification_policy.sql`
- `20260806_acct_021_admin_role_parity.sql`
- `20260806_sync_001_app_state_server_time.sql`
- `repair_002_durable_attendance_ledger_and_write_hardening.sql`
- `repair_007_durable_account_ledger.sql`
- `repair_008_server_guard_stale_writes.sql`
- `repair_009_attendance_ledger_anon_access.sql` — explicit production **NO-GO**.
- `repair_012_atomic_attendance_punch.sql`
- `repair_014_attendance_chronology_audit.sql` — current anonymous/authenticated grants remain **NO-GO** for production.
- `repair_016_attendance_effective_corrections.sql`
- `repair_017_attendance_same_intent_race.sql`
- `repair_020_retire_legacy_attendance_writer.sql`

### Data repair or production-only migrations held back

- `repair_001_full_backup_before_incident_repair.sql` — production backup operation.
- `repair_003_verification_keyed_to_email_and_interval_units.sql` — data backfill.
- `repair_004_incident_recovery_aug6.sql` — incident recovery.
- `repair_005_incident_recovery_merge_proof.sql` — historical merge recovery.
- `repair_008a_safety_snapshot_20260822.sql` — emergency safety snapshot.
- `repair_011_flowconfig_seed_cleanup.sql` — data cleanup.

## Next gate

Do not apply more migrations until the staging base is expanded deliberately with synthetic `platform_admins`, `auth_codes`, `staff_accounts`, `user_verification`, and attendance fixtures, or a reviewed baseline migration is created. Any Auth identity mapping, attendance writer/RLS/grant change, data repair, external dispatch configuration, or production promotion requires its separate Gate B approval and rollback/test package.
