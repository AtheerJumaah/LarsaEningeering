# Larsa attendance identity binding — Gate A decision package

**To:** Atheer Jumaah, Board Director  
**From:** CTO / Engineering Director  
**Date:** 2026-10-13  
**Decision requested:** whether the evidence and controls are sufficient to begin Gate B shadow enrollment.

## Executive decision

**Recommendation: NO-GO for Gate B enrollment. Continue Gate A only.**

The attendance workflow is behaviorally verified, but employee identity is not yet server-bound. The client can still supply the employee UID to the attendance RPC, and anonymous Supabase sessions are used by the current staff flow. Gate B should not begin until the prerequisites below are independently reviewed and approved.

This package is documentation only. No production permissions, rows, Auth users, migrations, sign-ins, or deployments were changed.

## Redacted evidence snapshot

Evidence is from read-only production queries and local source review against commit `1fdfaebc6ce30270c799bf49b3112dcfafd937ad`.

| Signal | Result | Meaning |
|---|---:|---|
| Current staff rows | 35 | 26 enabled/non-offboarded; 9 offboarded |
| Current enabled staff with email | 26 | Candidate population only; not yet enrolled |
| Current duplicate email groups | 0 | Must be rechecked immediately before enrollment |
| Blank-email staff rows | 6 | All are offboarded; no identity may be inferred |
| Durable staff ledger | 46 total; 35 live; 11 tombstoned | Historical ledger must not be treated as the current directory |
| Supabase Auth users | 446 total; 445 anonymous; 1 non-anonymous | The one non-anonymous user is unclassified |
| Server mapping table | Absent | No `staff_auth_identity` mapping currently exists |
| Direct attendance writer | Present | `lib/ledger.ts:99-118` still upserts `attendance_events` directly |

The existing Atheer live proof demonstrates one-click behavior, chronology, idempotency, and document/ledger parity. It does not demonstrate cryptographic binding of Atheer’s local staff ID to a Supabase Auth identity.

## HR/privacy handling requirements

These requirements apply to every remaining Gate A artifact and any future enrollment work:

- Keep the committed decision package aggregate-only. Do not commit raw employee emails, names, phone numbers, Auth UUIDs, tokens, passwords, PINs, session cookies, or screenshots containing unnecessary personal data.
- Maintain any row-level reconciliation worksheet in a restricted, access-audited location. Use redacted staff keys and hashed or truncated identifiers in review packets.
- Use synthetic identities for SQL, runtime, browser, migration, and rollback tests. A real employee account may be used only as an explicitly approved diagnostic canary, with one deliberate action per click and no credential capture.
- Do not copy production `larsaStaffV8` data into fixtures, tickets, chat, screenshots, or source control.
- Do not use email matching alone to establish employment identity. HR/owner confirmation is required for every enrollment and any email change or reassignment.
- Preserve attendance history. Corrections must be auditable; cleanup must never delete attendance rows or silently rewrite timestamps.
- Restrict Auth enrollment and disable/re-enable operations to an approved service-role/admin workflow. Never expose service-role keys to the browser.
- HR/Privacy must confirm the retention, access, and reassignment policy for staff/Auth mappings, enrollment evidence, correction evidence, and diagnostic logs before Gate B.

## Approvals still required

Atheer/CEO approval is required for the following decisions; engineering must not infer them:

1. Classify the single existing non-anonymous Auth user as viewer, administrator, employee, or unknown. Unknown means no enrollment or mapping.
2. Select the enrollment method: native Supabase email/password, magic link, or OTP. Existing local PBKDF2 secrets cannot be imported as Supabase password hashes.
3. Approve the first controlled canary account. Atheer `u1` is proposed only as an explicitly approved diagnostic account; credentials and Auth UUID remain out of source control and chat.
4. Define server-owned manager scope: team, department, project, or another controlled boundary. Local role/org JSON cannot authorize cross-employee writes.
5. Approve the relational correction-request/audit model and who can approve, reject, or materialize corrections.
6. Define HR/privacy retention, access review, and reassignment rules for mappings and audit records.
7. Approve the service-worker/cache observation window before the legacy `attendance_punch` execute grant can be revoked.
8. Decide how the six offboarded blank-email rows and eleven tombstoned ledger rows are represented in the reconciliation worksheet without guessing identity.

## Exact Gate B prerequisites

Gate B means **shadow enrollment only**. It does not revoke attendance grants and does not change the active local sign-in path. The following must be complete and signed off before starting:

### Identity and HR controls

- Restricted row-level worksheet completed for all 35 current staff IDs.
- Every row has a status: matched-pending-enrollment, blocked, or explicitly excluded.
- No duplicate current email, Auth collision, deleted Auth user, anonymous Auth user, or owner-uncertain match remains in the proposed canary set.
- HR/Privacy confirms enrollment authority, employee notice/consent process where applicable, access controls, retention, and reassignment handling.
- The existing non-anonymous Auth user is classified and excluded unless expressly approved.

### Database and application controls

- Shadow migration design reviewed: one `staff_uid` ↔ one non-anonymous `auth_user_id`, active-status constraint, normalized-email audit value, default-deny RLS, no `anon`/`authenticated` table write.
- Any new `SECURITY DEFINER` helper uses `set search_path = pg_catalog, public`, explicit `auth.uid()` checks, and narrow function ACLs.
- Shadow phase does not alter `attendance_events` policies/grants, legacy wrappers, app-state behavior, or local sign-in.
- A feature flag can limit the shadow check to one canary account and disable it without database rollback.
- A read-only pre-gate snapshot exists for table counts, policies, table ACLs, function ACLs/security modes, and migration versions.

### Testing and operations

- Synthetic fixtures exist for mapped self, disabled, anonymous, unmapped, mismatched UID, in-scope manager, out-of-scope manager, duplicate email, blank email, and Auth collision.
- SQL tests cover mapping and read scope; runtime/browser tests cover sign-in, refresh, sign-out, tabs, access preview, PIN step-up, and queue behavior.
- Rollback runbook is reviewed and tested in an isolated/synthetic environment. If no mapping rows exist, rollback removes only shadow objects; if mappings exist, they are revoked through the approved path before object removal.
- Monitoring is prepared for mapping mismatches, anonymous write attempts, 401/403s, 5xxs, queue growth, duplicate event IDs, and document/ledger parity.

## Rollback and release gates

Gate B may advance only in this order:

1. **Review gate:** Atheer/CEO and HR/Privacy approve the worksheet, mapping rules, retention, and canary.
2. **Synthetic test gate:** identity SQL, read-scope, enrollment, runtime, and browser suites pass with no production data.
3. **Shadow migration gate:** create the migration only after approval using `supabase migration new`; deploy only to the approved environment; do not touch attendance grants.
4. **Canary gate:** one approved account maps successfully; disabled/unmapped/anonymous/mismatched sessions fail; refresh, sign-out, tab duplication, and account switching preserve the server actor.
5. **Rollback gate:** any identity mismatch, unexpected 401/403, lockout, unauthorized target, or parity discrepancy disables the feature flag and pauses enrollment. No direct attendance grant is revoked during Gate B.
6. **Evidence gate:** capture only redacted mapping proof, deployment SHA, test results, and aggregate metrics. No raw credentials or unnecessary employee data.

The later authorization cutover is a separate gate. Direct `attendance_events` INSERT, broad anonymous policies, legacy RPC execution, and direct ledger upserts remain unchanged until every writer is server-authorized and the full test matrix passes.

## Required tests before any enforcement

New suites:

- `tests/attendance-identity-binding.test.mjs`
- `tests/attendance-identity-binding-sql.test.sql`
- `tests/attendance-identity-read-scope.test.sql`
- `tests/staff-auth-enrollment.test.mjs`
- `tests/attendance-auth-browser.smoke.mjs`

Existing contracts that must remain green or be explicitly updated:

- `tests/attendance-production-transaction.test.sql`
- `tests/attendance-effective-correction.test.sql`
- `tests/attendance-preserved-time.test.sql`
- `tests/atomic-attendance-punch-sql.test.sql`
- `tests/attendance-shared-state-noop.test.sql`
- `tests/app-state-cas-sql.test.sql`
- `tests/repair-guard-sql.test.sql`
- `tests/attendance-runtime.test.mjs`
- `tests/attendance-queue-runtime.test.mjs`
- `tests/clock-authority.test.mjs`
- `tests/clock-intent.test.mjs`
- `tests/punch-concurrency.test.mjs`
- `tests/single-press.test.mjs`
- `tests/never-locked-out.test.mjs`
- `tests/access-preview-signout.test.mjs`
- `tests/account-lifecycle.test.mjs`
- `tests/org-admin-role.test.mjs`
- `tests/role-hierarchy.test.mjs`
- `tests/durable-ledger.test.mjs`
- `tests/sync-clobber-fix.test.mjs`

## Explicit NO-GO items

Until the approvals and prerequisites above are complete, engineering must not:

- create or deploy the shadow migration;
- create, invite, disable, or reassign a production Auth user;
- write production mapping rows or alter production staff rows;
- revoke or expand attendance RLS policies, grants, or function ACLs;
- deploy server identity-binding code or change local sign-in behavior;
- treat `auth.role()='authenticated'` or an anonymous session as employee authorization;
- accept client-supplied UID, actor, role, email, or manager fields as authority;
- use real employee records as automated test fixtures;
- delete, rewrite, or “clean up” historical attendance events;
- claim that attendance is server-authenticated employee attendance;
- use the production probe to create punches or bypass identity controls.

## Decision record requested from Atheer

Please record one of these decisions:

- **HOLD / continue Gate A** — recommended; resolve the eight approval questions and complete the restricted worksheet.
- **AUTHORIZE Gate B preparation only** — design/test work may continue, but no production mapping, Auth operation, migration, permission change, or deployment.
- **AUTHORIZE Gate B shadow enrollment** — only after all exact prerequisites above are attached and HR/Privacy approval is recorded.

Until a written decision is recorded, the engineering status is **HOLD — NO-GO for Gate B enrollment and all production identity changes**.
