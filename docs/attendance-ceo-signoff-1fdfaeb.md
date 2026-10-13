# CEO Sign-off — Larsa Attendance Identity Objective

**Review scope:** commit `1fdfaebc6ce30270c799bf49b3112dcfafd937ad` (`Guard intent-free attendance punches`)  
**Production evidence reference:** deployment `dpl_ETL1ZN8HDMnhiG1Zwih1XMEMUDG7` (reported READY for SHA `1fdfaeb`)  
**Decision:** **Conditional sign-off for behavioral operation only; identity-binding cutover is not approved.**  
**Review mode:** read-only. No production rows, permissions, policies, sign-in flows, or deployments changed.

## Verified

- The reviewed commit is `main`/`origin/main` and changes the intent-free
  attendance path plus its queue/clock contracts.
- Targeted regression tests pass: **20/20** across queue runtime, clock
  authority, clock intent, and single-press contracts.
- Explicit Clock In/Out intent is preserved. Compatibility callers without an
  intent first confirm server state; unavailable confirmation safely creates no
  punch.
- Same-intent clicks are idempotent; retries retain the event ID and original
  instant; concurrent employee actions serialize; account switching does not
  discard the prior employee's queued event.
- Prior live evidence supports behavioral correctness: deliberate attendance
  flows matched document/ledger rows, event IDs were unique, the UI ended Off
  the clock, and no duplicate-client-event groups were observed.
- The identity-binding plan correctly preserves the current residual claim:
  attendance is **audited but not cryptographically bound to the employee**.

## Unresolved / blocking

- Local password/PIN sign-in does not establish a real Supabase Auth employee
  session. `auth.uid()` is an anonymous session, not the local staff UID.
- The authoritative RPC still receives client-supplied employee/actor IDs;
  current grants/policies and RLS do not prove employee or manager authority.
- `lib/ledger.ts` retains a direct attendance ledger upsert; non-live writers
  (manager punches, corrections, recovery/import, shared-state/account writes)
  are not yet server-bound.
- The compatibility `attendance_punch` path and legacy clients require a
  cache/telemetry retirement gate before any execute grant is revoked.
- There is no fresh live Clock In → Clock Out proof on `dpl_ETL...` that also
  proves an Auth UID-to-staff mapping. Existing live evidence must not be
  relabeled as server-authenticated attendance.
- Manager/correction live workflow, physical device/sleep/mobile matrix,
  sustained-load performance, and the full repository suite remain unresolved.

## CEO disposition

- **Approved now:** continue bounded behavioral verification and local
  engineering preparation. Keep production grants, policies, rows, and sign-in
  behavior unchanged.
- **Not approved:** Gate E grant/policy cutover, direct INSERT revocation,
  legacy RPC retirement, or any claim of “server-authenticated employee
  attendance.”
- **Required claim until gates pass:** “client-supplied employee identity;
  audited but not cryptographically bound.”

## CEO activation record — Gate A

- **Decision:** Activated one bounded internal workstream.
- **Role:** Engineering Lead 01 — stable ID `ENG-ENG-01`, internal handle
  `EngineeringLead01`.
- **Authority:** CEO/COO. `/root` may coordinate and report, but may not
  activate, deactivate, hire, or retire the role.
- **Scope:** read-only identity/grant/policy/writer inventory plus preparation
  of un-deployed shadow mapping and rollback/test artifacts.
- **Safeguards:** no production permission, policy, row, sign-in, migration,
  deployment, enrollment, or external-state changes; no additional roles;
  stop on mismatch, lockout risk, unauthorized path, duplicate/missing event,
  or material latency regression.
- **Exit:** deliver inventory snapshot, call-site inventory, shadow schema/test
  proposal, risks, and Gate B go/no-go recommendation; CEO decides whether to
  continue, resize, or retire the seat.

## Exact next safe engineering block (Gate A; no enforcement)

1. Produce a read-only inventory of active local staff IDs/emails, duplicate or
   reused emails, enabled/offboarded accounts, existing `auth.users`, current
   grants/policies/function security modes, and every attendance/shared-state
   writer call site. Confirm no diagnostic rows remain.
2. Prepare (but do not deploy) a shadow-only `staff_auth_identity` mapping
   migration and its rollback/test fixtures. It must default-deny the mapping
   table and change **no** attendance grants, policies, rows, or sign-in flow.
3. After an explicit CEO activation decision and any required Atheer approval,
   enroll one controlled account only. Prove one-to-one mapping, disabled-user
   rejection, refresh/sign-out/account-switch behavior, and no change to the
   existing local login.
4. Stop and escalate if any mapping mismatch, lockout, unexpected write,
   unauthorized target, 401/403, duplicate/missing event, or material latency
   regression appears. Roll back only the shadow mapping/flag; do not revoke
   production grants in Gate A.

**Acceptance evidence for the next block:** inventory snapshot, redacted
mapping proof, test results, call-site inventory, explicit authority record,
and a written go/no-go decision for Gate B. `/root` may coordinate and report
this block but may not activate, deactivate, hire, or retire the engineering
seat; that staffing authority remains with the CEO.

## Gate A checkpoint and next activation

The completed `EngineeringLead01` inventory found 35 non-tombstoned staff rows
(26 enabled, 9 disabled/offboarded), 34 without an active non-anonymous Auth
identity, and 445 anonymous users out of 446 Auth users. Reused/blank email
records, broad attendance policies, direct ledger upserts, public account-ledger
RPCs, and live/source drift on `app_state_put` remain unresolved. The CEO
decision is **HOLD — do not proceed to Gate B**.

The CEO immediately activated the next bounded block for `EngineeringLead01`:
prepare a canonical identity-reconciliation matrix, source/live security-drift
register, writer-to-gate matrix, and static shadow-artifact review. The block
must not execute SQL or alter production state. Its checkpoint deliverables are
a remediation packet, unresolved decisions for Atheer, and a CEO go/no-go
recommendation.
