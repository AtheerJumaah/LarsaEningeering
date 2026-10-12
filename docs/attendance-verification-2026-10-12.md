# Attendance repair and verification — 12 October 2026

## Verified deployment chain

- Application: https://larsaeng.app (Vercel, not Netlify).
- GitHub: AtheerJumaah/LarsaEningeering, main.
- Vercel: larsa-eningeering, project prj_bKC7SSpWkrYs9LuZIii8X2aFcWqk.
- Production database: larsa-control, fqxknodpkjdmueevafdk, us-east-1.
- Starting production commit: 985e23ebcf4f01c6065c17aa1702ad8a96a56fb0.
- First verified release: 57f07bbeb28651d943c2358ff512f24db6eedc33, deployment dpl_H2yofqy67M311Zmhrrz95HXS5PXk, READY with larsaeng.app alias. A follow-up adds bounded RPC cancellation and query materialization; its final deployed SHA is supplied in the delivery message.

## Checklist

“Reported” means the user described the symptom; it does not prove a specific cause. “Verified” below identifies the tested boundary, not an unconditional guarantee for all devices.

| Issue | Origin | Current status / evidence |
|---|---|---|
| Clock In/Out incorrect | Reported | Confirmed, fixed; runtime/API/browser verification and live deliberate In/Out confirmed. Intermittent live network/API delay remains unresolved. |
| Ctrl + Shift + R required | Reported | Sync recovery fixed and runtime-verified; signed-in browser automatically upgraded to the new deployment without a hard refresh. |
| No automatic entry/active synchronization | Reported | Fixed; login, entry, focus, visibility, reconnect, realtime and 15-second visible-tab fallback. Failed bootstrap recovery runtime-verified. |
| Ignored clicks / minutes of delay | Reported | Stale embedded refusal reproduced and fixed. Browser verified Saving state and slow response. Live Break End receipt was delayed 78.6 seconds and Out 27.2 seconds, despite database RPC execution maximum 2.9 seconds. Network/connection delay remains unresolved; original instants survived and no duplicates appeared. |
| Unintentional Clocked In/Out status | Reported | Confirmed three production ledger/document status disagreements due to upload ordering. Startup historical upload reproduced and removed. No evidence that every reported status change was an unintended employee action. |
| Records/hours unexpectedly change | Reported | Fixed delayed-time substitution, unfinished-break bleed, and correction timezone reinterpretation; calculation and transactional tests passed. Historical payroll repair was not performed. |
| Timeouts/offline | Risk to investigate | Confirmed offline time loss, fixed. Browser verified failed request and commit-before-timeout retry. Original-time review queue retained for ambiguous/older-than-36-hour actions. |
| Devices/tabs/embedded panel conflicts | Risk to investigate | Atomic employee lock and stable IDs; strict panel identity and intent; browser verified second-tab update. Physical independent-device testing pending. |
| Old caches/service workers | Risk to investigate | Network-first engine loading retained; worker v48; idle-only replacement reload and minute update checks. Live browser upgraded automatically after another tab installed the new worker. Mobile/old browser matrix unverified. |
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
9. Live embedded Timesheet showed gross duration (0.15 h) for the test shift instead of net duration (281.252 seconds). A test invoking the actual packed sessions23 function failed before the fix. Ten packed session calculators now consume the native parent calculation, including break deductions and review flags; they no longer maintain conflicting calculations. Live recheck confirmed 0.08 h (rounded net) rather than 0.15 h. Home also said “No shift recorded” after a saved shift; it now correctly says “Off the clock,” without implying that history is missing. The parent bridge re-checks the acting employee and data scope, retains historical disabled staff for authorized viewers, and refuses signed-out/disabled actors. Final worker cache v50 delivers these changes.
10. During a slow break save, Clock Out appeared available but the shared writer lock rejected it. A new browser test and two tests invoking the actual writer failed before the fix. A deliberate different action now enters the durable queue immediately without starting another concurrent server writer. Both confirmed and review-rejected preceding events consume only their own IDs, preserving the subsequent Out. Same-intent clicks remain one event; account switching stops the prior queue without discarding it.

## Traceability and remaining security limitation

New atomic punches carry employee ID, declared acting employee ID, action source, stable event ID, original instant, server receipt timestamp, Supabase auth session ID and device ID/user-agent. An insert trigger captures receipt/session metadata for all legacy/import writers too. Historical records lacking actor metadata were not retroactively attributed.

**Unresolved:** existing Supabase policies allow anon/authenticated direct attendance INSERT and public SELECT. Staff login is separate from the Supabase anonymous session. A declared acting employee ID is not cryptographic proof of employee identity, and an older/custom client can bypass the new RPC. Closing this safely requires migrating employee authentication/authorization and legacy correction/import writers together. The new audit helps investigation but does not eliminate this security gap. No claim is made that all unauthorized writes are prevented.

## Verification evidence

- Four runtime regressions failed before fixes, then passed.
- Original-time SQL test failed before migration, then passed.
- Same-intent timestamp-order race test failed before the follow-up migration, then passed.
- Three production rollback-only SQL suites verify time preservation, idempotency, chronology, invalid/future/out-of-order rejection, breaks, audit metadata and effective corrections. Confirmed zero diagnostic attendance rows remain.
- 35 runtime/calculation/correction/trim/duration tests passed, including late-auth and request-abort checks and direct native correction planner tests.
- Three packed-timesheet runtime tests passed after reproducing the live net/gross mismatch, including the actual parent bridge's scope and daily-segment aggregation. Four actual-writer queue tests passed. Combined targeted runtime/calculation suites: 42 passed.
- Eight isolated Chromium browser scenarios passed: slow save with disabled duplicate press; confirmed breaks; two-tab propagation; failed network/reconnect; timeout after server commit; refresh without a new punch; quota failure before request; deliberate Out queued during a slow break save.
- Production build, TypeScript and packed-engine parsing passed before release.
- Full pre-change suite baseline: 508 tests, 494 pass, 14 failures (existing assertions/environment issues). Latest whole-suite run: 532 tests, 487 pass, 45 fail. This includes assertions pinning replaced implementation patterns (including accepting unsigned panels, cached break refusal and separate packed calculators). These assertions need revision; the full suite is not claimed green. New behavioral evidence above is reported separately.

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

The long live delays prevent a claim that all response-time problems are solved. They demonstrate pending/retry safety and original-time preservation, not fast service under every connection.

## Remaining verification / limitations

- Physical second device, real device sleep/resume and mobile browser cache matrix.
- Live authorized manager and non-self correction approval workflow.
- GitHub/Vercel runtime logs were unavailable to the connected account (403); no clean runtime-log scan is claimed.
- The full legacy source-assertion suite is not green; separate passing behavioral tests are not a substitute for maintaining that suite.
- For historical complaints, employees/event dates are needed to attribute each individual change; legacy audit gaps cannot be invented away.
