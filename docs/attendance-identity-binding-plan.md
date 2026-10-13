# Attendance identity binding — read-only implementation plan

**Owner:** CTO / Engineering Director  
**Requested by:** CEO / Chief of Staff (`/root`)  
**Board oversight:** Atheer Jumaah  
**Baseline reviewed:** commit `1fdfaebc6ce30270c799bf49b3112dcfafd937ad` (`Guard intent-free attendance punches`)  
**Decision in this document:** plan only. No production permissions, rows, migrations, sign-in flows, or deployments were changed while preparing this plan.

## 1. Evidence review and what it proves

The current behavior is materially safer than the original clock path, but it is not yet server-authenticated employee attendance.

- `1fdfaeb` is the current `main` commit and changes `app/page.tsx` plus intent/queue contract tests. A read-only Vercel deployment lookup confirms production deployment `dpl_ETL1ZN8HDMnhiG1Zwih1XMEMUDG7` is READY and serves GitHub SHA `1fdfaebc6ce30270c799bf49b3112dcfafd937ad`.
- The documented Atheer Jumaah (`u1`) live proof records a deliberate In → Break Start → Out flow on deployment `dpl_7UVVDSf3LKEhu16DbhMMADraiC3o`, sourced from commit `1c7a0f0`; the later Clock In → Clock Out recheck is recorded on deployment `dpl_BstE1WoWVa1KhuaSpwAUjj91k9GQ`, sourced from `3333a3b`. The subsequent test-only release is `a6098ce` / `dpl_CtD95gTBbcEstoE8PcjCG7femLyE`.
- The later recheck is good behavioral evidence: one deliberate In and one deliberate Out, matching document/ledger rows, unique client event IDs, actor `u1`, source/device/session metadata, no pending banner, and zero duplicate-client-event groups. The repository does not contain a fresh, separately recorded Atheer Clock In→Clock Out proof tied specifically to `dpl_ETL1ZN8HDMnhiG1Zwih1XMEMUDG7`; the prior proof does not prove that the server authenticated Atheer as `u1`.
- `app/page.tsx` validates the employee password/PIN against the shared `larsaStaffV8` JSON document and `completeSignIn` stores a local session. It does not establish a Supabase Auth session for that employee.
- `lib/supabase/sync.ts` and `lib/attendance-punch.ts` call `signInAnonymously()` when needed. `record_attendance_action` receives `p_uid` and `p_actor_employee_id` from the client and records `auth.uid()` as `auth_session_id`; that UUID identifies the anonymous Supabase session, not the local employee identity.
- `repair_009_attendance_ledger_anon_access.sql` opened broad attendance SELECT/INSERT policies; `repair_014_attendance_chronology_audit.sql` grants the action RPC to `anon, authenticated`; `repair_020_retire_legacy_attendance_writer.sql` leaves the old `attendance_punch` wrapper executable by `authenticated` for compatibility. `lib/ledger.ts:99-118` still performs a direct `attendance_events.upsert`.

Therefore the correct current claim is: **the Atheer flow is behaviorally verified and auditable, but employee identity/permission enforcement remains client-supplied.** Do not describe it as “authenticated production attendance” until the gates below pass.

## 2. Target state

1. Every employee who can write attendance has a real, enabled Supabase Auth identity mapped one-to-one to the immutable Larsa staff UID.
2. The database derives the acting staff UID from `auth.uid()`; client-provided `uid`, `actor_id`, name, email, role, and manager fields are hints for display/audit only and cannot authorize a write.
3. Self punches, manager punches, approved corrections, recovery/import events, and shared-state/account writes use separate server-checked operations. Every operation records actor, target, source, stable event/correction ID, original event instant, receipt time, auth UID/session, and device metadata.
4. `attendance_events` remains append-only. Direct client INSERT is revoked. The authoritative RPC is `SECURITY DEFINER` only if its body has pinned `search_path`, explicit `auth.uid()` mapping, role/scope checks, idempotency, chronology checks, and an audit trail.
5. Reads are scoped to self or a server-authorized manager/admin. Current-state confirmation and reconciliation use scoped policies/RPCs; no broad employee attendance read remains.
6. Local PIN remains a convenience/step-up flow only after a real Supabase session exists. A PIN or local JSON password alone is never accepted as the server identity.

## 3. Exact implementation surface

### New database migration(s)

Create migrations in `supabase/migrations/` in this order. Names are proposed and must be assigned only when the implementation is authorized.

1. **`20261013_attendance_identity_shadow.sql`**
   - Create `public.staff_auth_identity` with `staff_uid` primary key, `auth_user_id uuid unique not null`, normalized email, enabled/status, enrollment/disable timestamps, and immutable audit fields.
   - Add a unique normalized-email constraint and reject duplicate active mappings.
   - Add `public.current_staff_uid()` and `public.current_staff_role()` helpers keyed only from `auth.uid()`; unmapped/disabled sessions return NULL/no role.
   - Enable RLS and default-deny table access. Grant no table write to `anon` or `authenticated`; bootstrap is service-role/admin RPC only.
   - Add a non-mutating mapping/audit view or RPC for rollout telemetry. This phase must not change attendance grants.

2. **`20261013_attendance_identity_authorization.sql`**
   - Replace `record_attendance_action` with a server-derived actor. Require a mapped, enabled `auth.uid()`; require `p_uid = current_staff_uid()` for self actions; require an explicit mapped manager/admin capability for another target.
   - Treat a supplied `p_actor_employee_id` as a consistency check, never as authority; reject a mismatch.
   - Run as a tightly reviewed `SECURITY DEFINER` function with `set search_path = pg_catalog, public`, pinned function signature, `auth.uid()` null checks, and explicit status/chronology/idempotency checks.
   - Add scoped read helpers or policies for current state, reconciliation, and manager views. Preserve removed-ID semantics and effective correction chronology.

3. **`20261013_attendance_nonlive_writers.sql`**
   - Add server-checked operations for approved corrections, manager actions, and recovery/import. Prefer an `attendance_corrections` relational request/audit table over trusting approval JSON in `app_state`.
   - Require a stable correction ID and a server-side approved state before materializing correction events. Require a manager/admin role and target scope for manager/import writes. Service-role-only bulk recovery is a separate path.
   - Migrate or retire the compatibility `attendance_punch` signature; it must not invent receipt-time events or bypass the authoritative writer.

4. **`20261013_attendance_grant_cutover.sql`**
   - Revoke `INSERT` on `public.attendance_events` from `authenticated` and `anon`; remove broad insert policies from `repair_009`.
   - Keep only scoped SELECT (or scoped read RPCs) for mapped users. Revoke direct table writes on all attendance paths.
   - Revoke `EXECUTE` on legacy `attendance_punch` only after the cache/telemetry gate proves no calls remain and an approved rollback path exists.

5. **`20261013_shared_state_identity_gate.sql`** (separate but required for complete closure)
   - Require `current_staff_uid()` for `app_state_put`, `staff_account_upsert`, `staff_account_tombstone`, and `staff_account_untombstone`.
   - Do not use the client-editable `larsaStaffV8.users[].access` or `actorEmail` as server authority. Gate account/role changes through a server-authorized admin operation.
   - Preserve the existing CAS and healing behavior; first add diff/role checks, then narrow grants after dual-session adoption.

### Exact application and function files

| File | Required change after authorization |
|---|---|
| `app/page.tsx` (`completeSignIn`, sign-in flow around lines 5838 and 6162–6315) | Establish/refresh a real Supabase Auth session, resolve the mapped staff context, and refuse an employee session without a matching enabled mapping. Keep local PIN/password only as UX/step-up during migration; never let access preview change the server actor. Call `supabase.auth.signOut()` on sign-out. |
| `lib/supabase/sync.ts` (`ensureSession`, bootstrap and reconnect) | Anonymous session may exist only before employee sign-in. Once a staff session is active, require/refresh the mapped Auth session and do not silently fall back to anonymous for writes. Keep CAS/reconnect behavior intact. |
| `lib/attendance-punch.ts` | Require a non-anonymous `getUser()` session; remove authorization dependence on client `uid`/`actor_id`; call the new RPC and handle “unmapped/disabled/forbidden” as a hard, non-queued result. |
| `lib/ledger.ts` (`flushLedgerQueue`, `confirmClockState`, `reconcileStoreFromLedger`) | Replace direct `.from("attendance_events").upsert` with the server-checked event/import RPC. Keep read calls only if scoped policies allow them; otherwise use the new current-state/reconcile RPCs. Preserve idempotency, queue retry, removed IDs, and chronology. |
| `lib/accounts-ledger.ts` | Make account upsert/tombstone calls rely on server-mapped actor/role, not local `by`/role strings; handle forbidden/unmapped outcomes without changing local state. |
| `lib/verification.ts` and `supabase/functions/auth-code/index.ts` | Preserve email verification, but do not treat custom code verification as a Supabase Auth session. Bind any verification side effect to the mapped staff record and real Auth UID. |
| `supabase/functions/auth-policy/index.ts` | Replace self-asserted actor email/role for staff administration with the authenticated, mapped actor; keep platform policy changes service-role controlled. |
| `supabase/functions/viewer-admin/index.ts` | Review shared admin trust assumptions; Viewer Auth is already real, but staff admin calls must not inherit a local-role assertion. |
| `supabase/functions/staff-auth/index.ts` (new) | Service-role enrollment/disable/recovery broker: create or invite Auth users, write the mapping, enforce one-to-one email/UID ownership, and audit every enrollment. Never expose the service-role key. |
| `supabase/functions/send-mail` (deployed source unavailable) | Confirm invite/reset contract before enabling enrollment. If its source cannot be recovered, use a supported Supabase Auth invite/reset flow rather than expanding the undocumented contract. |
| `scripts/attendance-production-probe.mjs` | Keep read-only; add an explicitly authenticated test mode only after a designated test account exists. Never use the probe to create punches or bypass the new mapping. |
| `tests/run-sql-tests.sh` | Add the new migration files and identity/auth test SQL in migration order; preserve rollback-only execution and diagnostic cleanup. |

## 4. Migration gates and rollback conditions

### Gate A — inventory and shadow enrollment (no enforcement)

Read-only checks must produce: active `larsaStaffV8` IDs/emails, duplicate/blank/reused emails, enabled/offboarded accounts, existing `auth.users`, current grants/policies/function security modes, and all call sites of `attendance_events`, `record_attendance_action`, `attendance_punch`, `app_state_put`, and account-ledger RPCs. Back up schema metadata and verify no test/diagnostic rows remain.

Enroll only a controlled account first (Atheer `u1` if explicitly approved), in a shadow mapping. Prove one-to-one mapping, disabled-account behavior, sign-out/session expiry, and no change to existing local login. Roll back the mapping row and feature flag if any mismatch or lockout occurs; do not revoke grants in this gate.

### Gate B — dual-session canary

Use a feature flag for one controlled account and then a small cohort. A successful sign-in must show:

- Supabase `auth.uid()` maps to the expected staff UID;
- the local user email and mapped normalized email match;
- disabled/offboarded users cannot acquire or retain a write-capable session;
- refresh, tab duplication, sign-out, account switching, PIN step-up, and access preview preserve the real server actor;
- anonymous sessions can read only the explicitly allowed pre-sign-in surface and cannot write attendance.

Rollback is a client feature-flag disable to the pre-enforcement writer; no database grant is revoked until this gate is stable.

### Gate C — server shadow authorization

Run the new identity checks in telemetry/shadow mode while the old behavior remains available. Compare client-declared UID versus server-mapped UID for every write attempt. Required result: 100% match for the canary/cohort, zero unmapped production writes, zero disabled-account writes, and no unexpected manager-target writes. Investigate every mismatch; do not “fix” metrics by accepting the client value.

### Gate D — non-live writer cutover

Before revoking direct INSERT, all paths must use server-checked operations: live self-punch, break actions, manager punch, approved correction, recovery/ledger replay, CSV/import tools, and any custom/legacy client. `lib/ledger.ts` direct upsert must be gone. Account and shared-state RPCs must reject self-asserted admin roles. Existing offline queues must either be upgraded into the new RPC format or be safely held for review; never replay them through a bypass.

### Gate E — grant/policy cutover

Only after A–D pass:

- revoke direct attendance INSERT and broad anon/authenticated insert policies;
- narrow reads to self/authorized manager or server read RPCs;
- revoke legacy `attendance_punch` execution after no-call telemetry exceeds the agreed cache lifetime;
- verify `pg_proc` signatures/security modes and `information_schema.role_table_grants` against an expected snapshot;
- run rollback-only SQL tests as the mapped canary and as anonymous/unmapped/disabled roles.

Rollback trigger: any unexplained 401/403, missing or duplicate event, document/ledger mismatch, unauthorized target write, or material attendance latency regression. Restore the last known-good application/RPC version only if it does not re-open direct writes; otherwise pause attendance writes and use the audited correction process.

### Gate F — authenticated live proof and watch window

After the authorized deployment, repeat Atheer’s deliberate one-click In → Clock Out on the deployed SHA with a real mapped Supabase user. Capture deployment ID, Auth UID-to-staff mapping proof (redacted), client event IDs, original/receipt timestamps, UI status, ledger/document parity, and duplicate query result. Monitor 24 hours at minimum for 401/403s, 5xx/504s, pool/statement timeouts, queue growth, duplicate IDs, and unmapped write attempts. This is the first point at which “server-authenticated employee attendance” may be claimed.

## 5. Required tests

### New tests

- `tests/attendance-identity-binding.test.mjs`: source contracts for non-anonymous session requirement, no client UID authority, preview isolation, and explicit forbidden/unmapped handling.
- `tests/attendance-identity-binding-sql.test.sql`: mapped self write succeeds; mismatched UID, anonymous, unmapped, disabled, and manager-without-scope writes fail; event actor/auth UID are server-derived; direct table INSERT fails after Gate E; append-only and idempotency remain intact.
- `tests/attendance-identity-read-scope.test.sql`: self reads, manager scoped reads, cross-team reads, removed IDs, and reconciliation boundaries.
- `tests/staff-auth-enrollment.test.mjs`: one-to-one email/UID enrollment, duplicate/reused email, disable/re-enable, session refresh and sign-out behavior.
- `tests/attendance-auth-browser.smoke.mjs`: real Auth session, In → Out, break and correction denial/approval, two tabs, reload, offline queue, access preview, and account switching.

### Existing tests that must remain green or be updated with an explicit contract change

- SQL: `tests/attendance-production-transaction.test.sql`, `tests/attendance-effective-correction.test.sql`, `tests/attendance-preserved-time.test.sql`, `tests/atomic-attendance-punch-sql.test.sql`, `tests/attendance-shared-state-noop.test.sql`, `tests/app-state-cas-sql.test.sql`, `tests/repair-guard-sql.test.sql`.
- Runtime/browser: `tests/attendance-runtime.test.mjs`, `tests/attendance-queue-runtime.test.mjs`, `tests/clock-authority.test.mjs`, `tests/clock-intent.test.mjs`, `tests/punch-concurrency.test.mjs`, `tests/single-press.test.mjs`, `tests/never-locked-out.test.mjs`, `tests/attendance-browser.smoke.mjs`, `tests/durability-e2e.smoke.mjs`.
- Auth/access/account contracts: `tests/access-preview-signout.test.mjs`, `tests/account-lifecycle.test.mjs`, `tests/org-admin-role.test.mjs`, `tests/role-hierarchy.test.mjs`, `tests/durable-ledger.test.mjs`, `tests/sync-clobber-fix.test.mjs`, `tests/qa-spec-sql.test.sql`.
- Build/release: TypeScript compilation, `npm test`, artifact validation, lint diff, and a migration privilege/function snapshot. A stale source assertion must be updated deliberately; it cannot be counted as a harmless baseline failure for this security cutover.

## 6. Open decisions before implementation

1. **Employee enrollment:** native Supabase email/password or OTP is recommended. Existing local PBKDF2 password hashes cannot be imported as Supabase password hashes. PIN-only/no-mailbox accounts need an approved enrollment method; a local PIN cannot mint a server identity.
2. **Manager scope:** define whether manager permissions are team/department/project scoped in a server-owned table rather than inferred from `larsaStaffV8` JSON.
3. **Correction authority:** approve the relational correction/request table and retention/audit policy before changing correction materialization.
4. **Legacy clients:** set the cache/service-worker retirement window and the agreed no-call observation period for `attendance_punch` before revoking its execute grant.
5. **Shared-state boundary:** decide whether to constrain `app_state_put` by JSON diff in the short term or move staff identity/roles/attendance summaries into relational tables before final enforcement.

Until these decisions and gates are approved, leave production grants and sign-in behavior unchanged and continue to report the residual risk exactly as: **client-supplied employee identity; audited but not cryptographically bound.**

