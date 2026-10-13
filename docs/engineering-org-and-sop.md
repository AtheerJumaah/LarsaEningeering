# Larsa Engineering Organization and Standard Operating Procedure

**Owner:** CTO / Engineering Director
**Accountable executive:** CEO / Chief of Staff (`/root`)
**Board oversight:** Atheer Jumaah, Board Director
**Status:** Operating baseline; applies to development, QA, security, releases, and incidents.
**Scope:** Larsa Accounting / Engineering Control application, including the Next/Vinext app, Supabase database/RLS/RPCs, attendance and timesheet workflows, payroll/accounting surfaces, and deployment configuration.

## 1. Engineering organization

The organization is deliberately small and role-based. One person may hold more than one role, but a production change must still have independent review for code, security-sensitive data access, and release approval.

| Role | Primary accountability | Required handoffs |
|---|---|---|
| CTO / Engineering Director | Architecture, priorities, staffing, engineering policy, risk acceptance, release/incident authority | Reports status and material risk to CEO/Chief of Staff; escalates board-level risk to Atheer Jumaah |
| Product / Engineering Manager | Scope, acceptance criteria, sequencing, dependency and capacity management | Maintains the work queue and definition of done; coordinates with QA and the business owner |
| Application Lead | React/Next/Vinext architecture, domain boundaries, accessibility, performance, frontend/backend implementation | Produces design notes and reviewable PRs; pairs with data/security owner on write paths |
| Data & Platform Engineer | Supabase schema, migrations, RPCs, RLS, auth identity mapping, backups, observability and deployment configuration | Supplies migration plan, rollback plan, privilege diff and post-release evidence |
| QA / Verification Lead | Test strategy, deterministic fixtures, browser/E2E coverage, regression triage and release evidence | Owns test report and independent release recommendation |
| Security & Privacy Reviewer | Threat modeling, authn/authz, RLS/grants, secrets, auditability, data minimization and incident support | Reviews every identity, payroll, accounting, attendance and privilege change |
| SRE / Release Engineer | CI health, artifact integrity, deployment controls, monitoring, rollback execution and incident command | Confirms release gates and writes the release record; does not self-approve a risky change |
| Business owner / Operations reviewer | Acceptance of payroll, accounting, attendance and reporting behavior; policy decisions | Signs acceptance criteria and verifies production smoke scenarios |

### Decision rights

- CTO may approve normal engineering changes after all gates pass.
- Security & Privacy Reviewer may block a change involving identity, privileges, financial records, attendance evidence, or material data exposure.
- QA / Verification Lead may block a release when required evidence is absent or a regression is unexplained.
- SRE / Release Engineer may stop or roll back a release when health signals breach the release thresholds.
- CEO / Chief of Staff accepts business risk that engineering cannot eliminate. Board Director Atheer Jumaah is informed of material security, financial-control, privacy, or availability risk; no board notification is required for routine defects.

No role may waive its own control for a production release. A waiver must name the risk, compensating control, expiry date, and approver.

## 2. Working agreements and change records

Every change is tracked by an issue or work item containing: problem statement, affected domain, acceptance criteria, data classification, owner, risk level, rollback strategy, and test plan. The PR links the work item and includes a concise “what changed / why / evidence / residual risk” summary.

Use small, reviewable changes. Keep schema migrations additive where possible. Never rewrite or delete immutable financial, attendance, audit, or payroll history to make a test pass. Preserve stable storage keys and event IDs. Do not deploy, revoke access, alter production policies, or run production writes without an explicit assignment and release authorization.

The repository’s current handover documents are part of the operating context. In particular, attendance identity enforcement is still a coordinated migration problem: the local staff login identity is separate from the Supabase anonymous session, and client-supplied employee IDs are not cryptographic authorization. Treat this as an open security risk until server-verified staff identity and permission checks are fully rolled out.

## 3. Standard operating procedure (SOP)

### A. Plan and design

1. Product/Engineering Manager records the outcome, owner, acceptance criteria, and risk classification.
2. Application Lead or Data & Platform Engineer writes a short design note for changes crossing UI, API, database, or event boundaries. Include invariants, compatibility behavior, observability, and rollback.
3. Security & Privacy Reviewer performs a lightweight threat model for all writes, identity, financial, attendance, payroll, export, or permission changes.
4. QA Lead identifies unit, integration, SQL rollback, browser, and negative-path tests before implementation.
5. CTO confirms capacity, sequencing, and whether the change is safe for the next release train.

### B. Implement and review

1. Work on a branch; do not commit secrets, production snapshots, or personal data.
2. Keep domain logic single-sourced. A packed/embedded view must call the authoritative parent calculation rather than maintain a competing attendance or payroll implementation.
3. For time and attendance, preserve the original client event instant, stable event ID, actor/source/session/device metadata, chronological ordering, idempotency, and explicit intent. Never substitute server receipt time for the employee’s recorded instant.
4. For database changes, include migration ordering, `search_path`/function security review, grants/RLS impact, transaction behavior, and a rollback-only test where feasible.
5. Reviewer checks correctness, authorization boundaries, error handling, accessibility, performance, and test quality. At least one reviewer must be independent of the author for production-bound changes.

### C. Verify

The QA Lead runs the smallest useful checks first, then the full applicable suite. The current baseline command is `npm test` from `LarsaEningeering`; TypeScript compilation, lint, SQL tests, browser/E2E tests, and artifact validation are added according to the change. A known baseline failure may be accepted only when documented and unrelated; no new failure is acceptable.

Verification evidence must identify commit, command, result, environment, and known limitations. Test data must be synthetic or explicitly designated diagnostic data. Live attendance checks use one designated account, one deliberate action per click, and no deletion of history; cleanup is by an auditable correction, not row removal.

### D. Release

The release owner assembles a release record containing:

- linked issue/PR and commit SHA;
- migrations and privilege/RLS diff;
- test and security evidence;
- deployment artifact and environment;
- monitoring plan, rollback trigger, and rollback owner;
- explicit business acceptance for accounting/payroll/attendance behavior.

The CTO, QA Lead, Security Reviewer (when in scope), and Release Engineer record their go/no-go decision. The Release Engineer deploys only after the CTO’s explicit release authorization. Production smoke tests verify health, sign-in/session behavior, one read path, and the changed business path. Monitor errors, latency, database timeouts/pool saturation, queue depth, duplicate event counts, and attendance/document parity before closing the release.

### E. Incident response

1. Any engineer may declare an incident for data-integrity risk, unauthorized access, payroll/accounting misstatement, attendance corruption, sustained errors, or material latency.
2. SRE/Release Engineer becomes Incident Commander; CTO is technical lead and CEO/Chief of Staff is business escalation.
3. Stabilize first: pause risky writes/releases, preserve logs and audit evidence, and communicate impact and scope. Do not edit history or hide diagnostic records.
4. Establish a timeline with UTC timestamps, affected release/commit, request IDs/event IDs, user impact, and known versus inferred facts.
5. Recover with the smallest reversible action. Validate with targeted tests and a post-recovery smoke test before resuming normal operations.
6. Within two business days, publish a blameless post-incident review: trigger, contributing factors, detection gap, customer/data impact, corrective actions, owner and due date.

## 4. Attendance and time-recording quality gates

Attendance is a controlled record, not ordinary UI state. The gates below apply to Clock In/Out, break actions, corrections, timesheets, schedules, live presence, exports, and any code that can influence worked duration.

### Gate T0 — data contract and identity

- Every event has a stable client event ID and immutable original UTC instant; retries are idempotent.
- Event chronology is based on effective occurrence time, including approved corrections, never insertion/receipt order.
- Actor, declared employee, source, auth/session, device, and correction metadata are captured where available.
- The acting employee and scope are server-verified before enforcement is considered complete. Client-supplied IDs, anonymous sessions, legacy writers, and direct table grants are documented as residual risk until retired.
- Breaks close correctly at Clock Out/new In and never create fabricated events.

### Gate T1 — functional and concurrency behavior

- One-click In, Out, Break Start, and Break End each produce at most one event under retries, slow network, duplicate clicks, refresh, reconnect, tab switching, sleep/resume, and account switching.
- Distinct deliberate actions are queued safely while another save is slow; same-intent duplicates are coalesced.
- Original event time survives delayed delivery, timeout, retry, and reconnect.
- Invalid, future, out-of-order, overlapping, unauthorized, and stale-correction requests are rejected without mutating valid history.
- Net duration subtracts breaks exactly once; embedded/packed/native paths consume the same authoritative calculator.

### Gate T2 — SQL, authorization, and audit

- SQL tests run in rollback-only transactions against the installed functions where possible and verify no diagnostic rows remain.
- RLS, grants, function ownership, `SECURITY DEFINER/INVOKER`, `search_path`, and legacy RPC callers are reviewed for every write-path change.
- Audit records include who/what/when/why plus stable event/correction identifiers; historical records are not silently rewritten.
- Corrections require the configured approval chain; out-of-turn overrides are explicit and auditable.
- Export/report totals reconcile to the authoritative ledger and document state.

### Gate T3 — browser and live evidence

- Isolated browser scenarios cover slow save, failed network/reconnect, refresh, quota failure, two-tab propagation, break transitions, and deliberate queued actions.
- At least one authorized end-to-end smoke test verifies sign-in, In → optional break → Out, UI status, closed session duration, document/ledger parity, unique event IDs, and no pending banner.
- For a release changing attendance, capture UTC request/receipt timestamps and deployment SHA. Do not claim latency is solved from a low-volume sample; distinguish behavioral correctness from capacity/load evidence.
- QA records device/browser coverage and outstanding limitations, including physical second-device or mobile coverage when not tested.

### Gate T4 — release and post-release monitoring

Release is blocked if any T0–T3 gate is missing, if full-suite failures are new/unexplained, if duplicate-event queries are non-zero, if attendance document/ledger parity is broken, or if auth/RLS impact is unreviewed. During the watch window, alert on RPC/API 5xx/504s, statement and pool timeouts, high origin latency, queue growth, duplicate event IDs, and unexplained status changes. The release record closes only after the watch window and QA/Release sign-off.

## 5. Attendance and engineering time-recording policy

Engineering attendance and time records must be accurate, timely, and auditable. Time is recorded against the actual workday and work item, not reconstructed from commit timestamps. Team members clock in/out and record breaks using the approved Larsa workflow. If offline or blocked, they enter a correction request as soon as service returns with the original local time, timezone, reason, and supporting context; managers approve corrections through the configured chain.

Daily quality check: each engineer confirms their status and that the prior day has no open session, impossible overlap, missing break closure, or unexplained duration. Weekly manager check: review exceptions, corrections, late entries, duplicate attempts, and team-level gaps; sample the audit trail rather than editing records directly. Payroll/accounting close: freeze the period, resolve or explicitly waive exceptions, export a reconciliation report, and retain approval evidence. No manager or engineer may silently alter another person’s record.

Operational targets for monitoring (not substitutes for correctness): 100% of worked days have a closed or explicitly reviewed session; 0 duplicate event IDs; 0 unexplained ledger/document mismatches; 100% of corrections include actor, reason, original instant and approval evidence; and 100% of releases affecting attendance pass T0–T4. Breaching a target creates a tracked incident or corrective work item.

## 6. Required records and retention

Retain PR reviews, design notes, migration and privilege diffs, test output, release approvals, deployment SHAs, smoke evidence, incident timelines, correction approvals, and reconciliation reports according to Larsa’s legal/payroll retention policy. Minimize personal data in logs and attachments; redact tokens, passwords, PINs, auth headers, and unnecessary employee details. Access to production evidence is least-privilege and audited.

## 7. First 30-day implementation backlog

1. Complete the shadow `staff_auth_identity` mapping and coordinated server-side authorization migration for attendance, corrections, imports, and shared-state writers; then remove direct employee ledger writes and retire compatibility RPCs.
2. Add a release checklist template and CI artifact that records test, TypeScript, lint, SQL, browser, security, and artifact-validation evidence by commit SHA.
3. Add a production-safe attendance parity/duplicate-event dashboard and alert thresholds for latency, pool exhaustion, 5xx/504s, queue depth, and status divergence.
4. Maintain a single ownership map for each route, RPC, migration, and critical calculator, including backup reviewer and incident contact.
5. Close the remaining device/sleep/mobile and live manager-correction evidence gaps, with synthetic or designated diagnostic accounts only.
