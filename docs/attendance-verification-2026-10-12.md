# Attendance repair and verification — 12 October 2026

## Verified deployment chain

- Application: https://larsaeng.app (Vercel, not Netlify).
- GitHub: AtheerJumaah/LarsaEningeering, main.
- Vercel: larsa-eningeering, project prj_bKC7SSpWkrYs9LuZIii8X2aFcWqk.
- Production database: larsa-control, fqxknodpkjdmueevafdk, us-east-1.
- Starting production commit: 985e23ebcf4f01c6065c17aa1702ad8a96a56fb0.
- First verified release: 57f07bbeb28651d943c2358ff512f24db6eedc33, deployment dpl_H2yofqy67M311Zmhrrz95HXS5PXk, READY with larsaeng.app alias. A follow-up adds bounded RPC cancellation and query materialization; its final deployed SHA is supplied in the delivery message.
- Final production release: 1c7a0f0fe1ed1cf484e6cdfdc4df02085cfad461, deployment dpl_7UVVDSf3LKEhu16DbhMMADraiC3o, READY, source GitHub main, larsaeng.app alias confirmed. The already-open signed-in tab automatically loaded this deployment without Ctrl + Shift + R. Database repairs 014–019 are installed in the verified production project.

## Checklist

“Reported” means the user described the symptom; it does not prove a specific cause. “Verified” below identifies the tested boundary, not an unconditional guarantee for all devices.

| Issue | Origin | Current status / evidence |
|---|---|---|
| Clock In/Out incorrect | Reported | Confirmed, fixed; runtime/API/browser verification and live deliberate In/Out confirmed. Intermittent live network/API delay remains unresolved. |
| Ctrl + Shift + R required | Reported | Sync recovery fixed and runtime-verified; signed-in browser automatically upgraded to the new deployment without a hard refresh. |
| No automatic entry/active synchronization | Reported | Fixed; login, entry, focus, visibility, reconnect, realtime and 15-second visible-tab fallback. Failed bootstrap recovery runtime-verified. |
| Ignored clicks / minutes of delay | Reported | Stale embedded refusal and rejection during another save reproduced and fixed. Live Break End receipt was delayed 78.6 seconds and Out 27.2 seconds. Supabase logs confirm database statement timeouts and connection-pool exhaustion; origin request time reached 98.3 seconds. Same-key serialization and identical-document no-op reduce avoidable load, but sustained backend capacity/latency remains unresolved. Original instants survived; no duplicates appeared. |
| Unintentional Clocked In/Out status | Reported | Confirmed three production ledger/document status disagreements due to upload ordering. Startup historical upload reproduced and removed. No evidence that every reported status change was an unintended employee action. |
| Records/hours unexpectedly change | Reported | Fixed delayed-time substitution, unfinished-break bleed, and correction timezone reinterpretation; calculation and transactional tests passed. Historical payroll repair was not performed. |
| Timeouts/offline | Risk to investigate | Confirmed offline time loss, fixed. Browser verified failed request and commit-before-timeout retry. Original-time review queue retained for ambiguous/older-than-36-hour actions. |
| Devices/tabs/embedded panel conflicts | Risk to investigate | Atomic employee lock and stable IDs; strict panel identity and intent; browser verified second-tab update. Physical independent-device testing pending. |
| Old caches/service workers | Risk to investigate | Network-first engine loading retained; final worker v51; idle-only replacement reload and minute update checks. Live browser upgraded automatically, including the final release, without a hard refresh. Mobile/old browser matrix unverified. |
| Storage failure / reconciliation | Risk to investigate | Startup replay removed, flag-only reconciliation now repaints. Browser verified storage failure blocks unqueued punch. Persistent denial of all browser storage remains unsupported; do not claim offline durability in that state. |
| Wrong employee / stale login | Risk to investigate | Unsigned/different panel identity rejected; disabled/missing cached account rejected; account-switch guard stops draining another user's queue. Server staff identity security remains unresolved (see below). |
| Forgotten/long/overnight/timezones/DST | Risk to investigate | 35 runtime/calculation/correction tests passed; server-corrected durations, stale/long flags, no automatic Clock Out, overnight requests capture exact instants. |
| Breaks / manager / approved corrections | Risk to investigate | Employee and manager punches/breaks share atomic operation; corrections use deterministic IDs, actor stamps and overlap checks. Database effective chronology respects approved trims. Live manager/correction workflow still pending. Legacy requests without exact instants require review/resubmission. |
| Wrong app/database deployment | Risk to investigate | GitHub/Vercel/domain/database chain verified before and after release. Production assets match the new deployment and production database. |

## Demonstrated root causes and changes

1. Production RPC sorted by inserted_at rather than occurred_at. Older In events uploaded later overrode newer Outs. Three production employees had a different latest ledger status by upload order than their document’s actual-time sequence. Fixed chronological ordering, including effective approved correction times; original ledger rows remain immutable.
2. The RPC ignored the supplied time and substituted server receipt time. A rollback-only production SQL test failed before the repair and passed after it. Original punch instants now survive retries; ambiguous delayed events require review rather than inventing a reconnection time.
3. Opening a cached staff document re-enqueued historical records as new “live” events. Reproduced with the actual ledger module in a VM. Startup now establishes a baseline and only resumes explicitly pending work. Ordinary storage writes compare against the existing log baseline.
4. Failed bootstrap did not install realtime and did not recover on focus. Reproduced with the actual sync module. Recovery now reinstalls realtime and polling, refreshes expired sessions, and preserves edits made during startup reads.
5. The packed Timeclock checked stale local state before handing off, and the outer handoff omitted employee identity. Reproduced by invoking the real packed clock function. Intent/identity now reach the parent first; embedded and standalone fallbacks cannot fabricate employee punches.
6. Open breaks were clamped separately to every future session. They now stop at Clock Out/new In. The real session builder is exercised by runtime tests, not a mirror implementation.
7. Corrections converted date/time in the reviewer’s timezone and generated non-stable materialization IDs. New requests freeze UTC instants/timezone at submission, support overnight work, retain actor and stable correction IDs, and refuse overlaps with other sessions. Native and embedded approval paths were updated.
8. Uncertain requests continued after their eight-second UI deadline. Follow-up aborts the RPC at that deadline and prevents an auth lookup finishing later from starting an abandoned punch. Retries still reuse the original event ID and instant. Effective-event SQL materializes the correction map and converted row once; no performance improvement is claimed from the variable live timing measurements.
9. Live embedded Timesheet showed gross duration (0.15 h) for the test shift instead of net duration (281.252 seconds). A test invoking the actual packed sessions23 function failed before the fix. Ten packed session calculators now consume the native parent calculation, including break deductions and review flags; they no longer maintain conflicting calculations. Live recheck confirmed 0.08 h (rounded net) rather than 0.15 h. Home also said “No shift recorded” after a saved shift; it now correctly says “Off the clock,” without implying that history is missing. The parent bridge re-checks the acting employee and data scope, retains historical disabled staff for authorized viewers, and refuses signed-out/disabled actors. Final worker cache v51 delivers these changes.
10. During a slow break save, Clock Out appeared available but the shared writer lock rejected it. A new browser test and two tests invoking the actual writer failed before the fix. A deliberate different action now enters the durable queue immediately without starting another concurrent server writer. Both confirmed and review-rejected preceding events consume only their own IDs, preserving the subsequent Out. Same-intent clicks remain one event; account switching stops the prior queue without discarding it.
11. Supabase logs for 08:50–09:03 UTC confirm 56 shared-state statement timeouts, nine PostgREST PGRST003 connection-pool timeouts, and multiple API 500/504s. Punch origin time reached 98,261 ms while successfully completed database punch SQL executions were at most 2,863 ms. Do not attribute this to employees' connections. A real sync-module test reproduced overlapping same-key writes; they now serialize while retaining later edits. A production rollback SQL test reproduced identical JSON saves advancing server stamps and broadcasting redundant realtime changes; an installed additive migration now returns the unchanged row without UPDATE. Both regressions pass after repair. These remove demonstrable waste; underlying sustained-load performance and service capacity still require verification.

## Traceability and remaining security limitation

New atomic punches carry employee ID, declared acting employee ID, action source, stable event ID, original instant, server receipt timestamp, Supabase auth session ID and device ID/user-agent. An insert trigger captures receipt/session metadata for all legacy/import writers too. Historical records lacking actor metadata were not retroactively attributed.

**Unresolved:** existing attendance policies have unconditional SELECT/INSERT predicates for anon/authenticated, but policies alone do not establish API access. A follow-up privilege inspection confirmed authenticated has SELECT/INSERT grants, while anon has neither grant. Supabase anonymous sign-ins assume the authenticated role, and staff login is separate from that session. A declared acting employee ID is not cryptographic proof of employee identity, and an older/custom authenticated client can bypass the new RPC. A separate legacy SECURITY DEFINER punch function is callable by anon and authenticated despite the direct-table anon restriction. Closing this safely requires migrating employee authentication/authorization and legacy correction/import writers together. The new audit helps investigation but does not eliminate this security gap. No claim is made that all unauthorized writes are prevented.

## Verification evidence

- Four runtime regressions failed before fixes, then passed.
- Original-time SQL test failed before migration, then passed.
- Same-intent timestamp-order race test failed before the follow-up migration, then passed.
- Three production rollback-only SQL suites verify time preservation, idempotency, chronology, invalid/future/out-of-order rejection, breaks, audit metadata and effective corrections. Confirmed zero diagnostic attendance rows remain.
- 35 runtime/calculation/correction/trim/duration tests passed, including late-auth and request-abort checks and direct native correction planner tests.
- Three packed-timesheet runtime tests passed after reproducing the live net/gross mismatch, including the actual parent bridge's scope and daily-segment aggregation. Four actual-writer queue tests passed. With the new sync serialization regression, combined targeted runtime/calculation suites: 43 passed.
- A fourth rollback-only production SQL suite verifies identical-document no-op and preservation of real CAS edits; the initial no-op assertion failed before repair and passed afterward.
- The existing comprehensive app-state CAS SQL suite also passed against the installed function after the no-op migration. Zero shared diagnostic rows remain.
- Eight isolated Chromium browser scenarios passed: slow save with disabled duplicate press; confirmed breaks; two-tab propagation; failed network/reconnect; timeout after server commit; refresh without a new punch; quota failure before request; deliberate Out queued during a slow break save.
- Production build, TypeScript and packed-engine parsing passed before release.
- Full pre-change suite baseline: 508 tests, 494 pass, 14 failures (existing assertions/environment issues). Latest whole-suite run: 533 tests, 488 pass, 45 fail. This includes assertions pinning replaced implementation patterns (including accepting unsigned panels, cached break refusal and separate packed calculators). These assertions need revision; the full suite is not claimed green. New behavioral evidence above is reported separately.

Browser fault tests use an isolated mock API, not the production account. Database tests use real installed production functions inside transactions that roll back. Neither alone proves a live employee flow; final live evidence is recorded separately below.

## Live production evidence

User-designated Atheer Jumaah account (u1), 12 October 2026, explicit diagnostic notes. Four events remain as an audited test shift; no history was deleted:

| Action | Original UTC instant | Server receipt UTC | Event ID suffix |
|---|---|---|---|
| In | 08:52:10.165 | 08:52:16.236 | 19bcf972-0138-497e-acef-2c6732f92bff |
| Break Start | 08:53:13.388 | 08:53:17.403 | 6d2f5e83-65c4-46e6-a92f-4abb1687f3c6 |
| Break End | 08:57:32.769 | 08:58:51.414 | 92d70562-635b-4de7-b908-fd2106711c1f |
| Out | 09:01:10.798 | 09:01:38.045 | ca031dd0-71ae-4e47-ba3a-b425e21f8936 |

All four have matching document IDs/status/timestamps, actor u1, source, Supabase session and device metadata. Final UI shows Off the clock / Clock In and the closed session as 5 min. Database elapsed 540.633 seconds minus break 259.381 seconds = 281.252 seconds (4 min 41.252 sec), correctly displayed rounded to five minutes. No extra events were created by retries or refresh. Zero rollback diagnostic rows remain.

The long live delays prevent a claim that all response-time problems are solved. Supabase API/database logs confirm server-side failures. The tests demonstrate pending/retry safety and original-time preservation, not fast service under sustained production load.

### Final-release live recheck

On deployment dpl_7UVVDSf3LKEhu16DbhMMADraiC3o, the same designated test employee deliberately recorded In → Break Start → Out, each with one click and diagnostic notes. Out closes the break span without fabricating a Break End event.

| Action | Original UTC instant | Server receipt UTC | Receipt delay |
|---|---|---|---|
| In | 09:55:38.836 | 09:55:39.365 | 0.529 s |
| Break Start | 09:56:02.690 | 09:56:03.137 | 0.447 s |
| Out | 09:56:08.758 | 09:56:09.393 | 0.635 s |

All three events match the document's IDs/status/timestamps and have actor/source/session/device metadata. The UI ended Off the clock, Clock In available, no pending banner. This short session adds 23.854 net seconds; combined with the earlier test, 305.106 net seconds display as five minutes. Seven distinct events exist across the two deliberate test shifts; no extras were created by startup, upgrades, refresh or retries. Neither test shift was deleted.

Post-release Supabase log sample starting 09:55 UTC: four punch requests, all HTTP 200 (maximum origin time 396 ms), and 19 shared-state saves, all HTTP 200 (maximum 4,658 ms). This is a healthy short sample, not a peak-load soak test. The deliberately overlapping slow-save case was proved in the isolated browser and actual-writer tests; the fast final live requests do not prove that timing overlap occurred in production.

Local screenshot evidence: attendance-production-proof-2026-10-12.jpg, showing the designated employee off the clock. Screenshot and this final evidence addendum are local delivery artifacts, not additional production code changes.

## Remaining verification / limitations

- Physical second device, real device sleep/resume and mobile browser cache matrix.
- Live authorized manager and non-self correction approval workflow.
- GitHub/Vercel runtime logs were unavailable to the connected account (403); no clean runtime-log scan is claimed.
- The full legacy source-assertion suite is not green; separate passing behavioral tests are not a substitute for maintaining that suite.
- For historical complaints, employees/event dates are needed to attribute each individual change; legacy audit gaps cannot be invented away.

## Connected Supabase follow-up review — 10:55–10:58 UTC

The Supabase security and Postgres skills guided an additional read-only advisor, function, privilege and log review. No production rows, policies, grants, sign-in flows or database configuration were changed during this follow-up.

### Confirmed access-control findings

- The installed legacy `public.attendance_punch(text,text,text,text,text,text,text[])` is owned by postgres, runs as SECURITY DEFINER, and is executable by anon and authenticated. It inserts a receipt-time In/Out directly, trusts the employee ID supplied by the caller, accepts caller-provided ignored event IDs, and does not delegate to `record_attendance_action`. Its `hashtext(uid)` lock differs from the repaired operation's `hashtextextended(uid,0)` lock, so the two paths do not share an employee lock. The current source has no caller of this legacy function, and no other public function body was found referencing it. No claim is made that a particular historical complaint used this path. [Supabase remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).
- `app_state_put` is also owned by postgres and SECURITY DEFINER. Authenticated can execute it; anon cannot. The authenticated role also has direct attendance SELECT/INSERT privileges. Neither database path is bound to the locally selected staff identity. Restricting only anon would therefore leave the employee-identity gap open. [Authenticated privileged-function guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
- RLS is enabled on all three active tables: attendance_events, app_state and staff_accounts. Broad table grants alone are not evidence of a successful write where RLS has no matching policy. Likewise, the advisor's missing-primary-key notices concern backup schemas; all three active tables have primary keys. These notices were not treated as reproduced attendance defects.

Recommended rollout: bind the existing employee sign-in screen to server-verified staff sessions; enforce employee/manager/correction permissions on each server write; migrate remaining correction/import/shared-state writers; then remove direct employee ledger INSERT and retire the unused legacy RPC. Preserve the current PIN/password user experience where feasible, but test account recovery, disabled accounts, manager permissions and existing open/offline clients before enforcement. Do not revoke permissions piecemeal and lock out employees.

### Additional post-release service evidence

For 10:00–10:55 UTC, Supabase edge logs show two repaired attendance RPC requests, both HTTP 200, maximum origin time 287 ms. There were 46 shared-state RPC requests, all HTTP 200, mean origin time 2,255.3 ms and maximum 18,991 ms. No legacy attendance_punch request appeared in this window. This is a low-volume observed sample, not a load test: shared-state latency still needs investigation and peak-load reliability remains unverified.

At 10:57 UTC, the designated test employee had no attendance events after the verified final Out at 09:56:08.758 UTC. The read-only follow-up created no punches. Database connection snapshot: 20 connections, including two active; it does not explain the earlier pool exhaustion by itself.

## Current release follow-up — 13 October 2026

- Commit `bd52dc9` retired the unused legacy `attendance_punch` writer in production: it is now SECURITY INVOKER, anonymous execution is revoked, and only authenticated execution remains for compatibility. A transaction-only smoke call succeeded and rolled back with zero residual rows.
- Commit `3333a3b` fixed the remaining native break-button race: QuickClock Start Break and End Break now use the same guarded writer as Clock In/Out and the embedded panel. Supervisor review confirmed no raw native `punchBreak` calls remain outside the guarded wrapper.
- Production deployment `dpl_BstE1WoWVa1KhuaSpwAUjj91k9GQ` is READY and serves `larsaeng.app` from GitHub commit `3333a3bf0eb4747fa6ddfa993658352bb3bf9238`.
- Live recheck on the designated Atheer Jumaah account: one Clock In showed `Clocked in since 01:33 AM · Office` and one Clock Out returned `Off the clock`, a new closed 0-minute session, and no pending banner. The database contains matching In/Out events with unique client event IDs, actor `u1`, source `employee-punch`, auth-session and device metadata. A global duplicate-client-event query returned zero duplicate groups.
- Targeted attendance/contract checks: 66 passed; TypeScript compilation passed. Full repository suite remains 532 passed / 19 failed out of 551; the failures are separate stale contracts/environment issues and are not claimed fixed by this release.

Remaining risks are unchanged: the compatibility wrapper still has no original client timestamp in its old signature, and server-side employee identity/permission enforcement remains client-supplied until the coordinated authentication migration is completed.

### Identity/permission audit — read-only follow-up

The production audit confirms that local `larsaStaffV8` login identity is separate from Supabase's anonymous session: `auth.uid()` is not the employee ID. `record_attendance_action` remains SECURITY INVOKER but executable by anon/authenticated, and stores the client-provided employee/actor IDs. Attendance RLS policies and authenticated direct table grants therefore do not yet enforce employee or manager authorization. The safe next boundary is a shadow `staff_auth_identity` mapping, one controlled-account migration, then server-side RPC authorization and only afterward removal of direct grants. No permissions were revoked in this block.

### Test-suite cleanup follow-up — 13 October 2026

- Windows/compiler and stale attendance/sync contracts were updated without production runtime changes.
- Full repository suite now passes: **602 tests, 0 failures**; TypeScript and diff checks pass, including strict recovery and explicit-intent regressions.
- Commit `a6098ce` is deployed as Vercel production deployment `dpl_CtD95gTBbcEstoE8PcjCG7femLyE`, READY, with `larsaeng.app` returning HTTP 200.
- These test-only changes do not alter the previously verified Clock In/Out runtime path.
