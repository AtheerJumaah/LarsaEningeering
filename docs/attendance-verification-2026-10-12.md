# Attendance repair and verification — 12 October 2026

## Verified deployment chain

- Application: https://larsaeng.app (Vercel, not Netlify).
- GitHub: AtheerJumaah/LarsaEningeering, main.
- Vercel: larsa-eningeering, project prj_bKC7SSpWkrYs9LuZIii8X2aFcWqk.
- Production database: larsa-control, fqxknodpkjdmueevafdk, us-east-1.
- Starting production commit: 985e23ebcf4f01c6065c17aa1702ad8a96a56fb0.
- Final release and live evidence: to be recorded after deployment verification.

## Checklist

“Reported” means the user described the symptom; it does not prove a specific cause. “Verified” below identifies the tested boundary, not an unconditional guarantee for all devices.

| Issue | Origin | Current status / evidence |
|---|---|---|
| Clock In/Out incorrect | Reported | Confirmed, fixed; runtime/API/browser verification; live test pending. |
| Ctrl + Shift + R required | Reported | Sync recovery fixed and runtime-verified; worker release bumped, live upgrade pending. |
| No automatic entry/active synchronization | Reported | Fixed; login, entry, focus, visibility, reconnect, realtime and 15-second visible-tab fallback. Failed bootstrap recovery runtime-verified. |
| Ignored clicks / minutes of delay | Reported | Stale embedded refusal reproduced and fixed. Browser verified Saving state and 1.2-second slow API response. Individual employees’ historical network delays remain unattributed. |
| Unintentional Clocked In/Out status | Reported | Confirmed three production ledger/document status disagreements due to upload ordering. Startup historical upload reproduced and removed. No evidence that every reported status change was an unintended employee action. |
| Records/hours unexpectedly change | Reported | Fixed delayed-time substitution, unfinished-break bleed, and correction timezone reinterpretation; calculation and transactional tests passed. Historical payroll repair was not performed. |
| Timeouts/offline | Risk to investigate | Confirmed offline time loss, fixed. Browser verified failed request and commit-before-timeout retry. Original-time review queue retained for ambiguous/older-than-36-hour actions. |
| Devices/tabs/embedded panel conflicts | Risk to investigate | Atomic employee lock and stable IDs; strict panel identity and intent; browser verified second-tab update. Physical independent-device testing pending. |
| Old caches/service workers | Risk to investigate | Network-first engine loading retained; worker v48; idle-only replacement reload and minute update checks. Production upgrade pending. |
| Storage failure / reconciliation | Risk to investigate | Startup replay removed, flag-only reconciliation now repaints. Browser verified storage failure blocks unqueued punch. Persistent denial of all browser storage remains unsupported; do not claim offline durability in that state. |
| Wrong employee / stale login | Risk to investigate | Unsigned/different panel identity rejected; disabled/missing cached account rejected; account-switch guard stops draining another user's queue. Server staff identity security remains unresolved (see below). |
| Forgotten/long/overnight/timezones/DST | Risk to investigate | 31 runtime/calculation/correction tests passed; server-corrected durations, stale/long flags, no automatic Clock Out, overnight requests capture exact instants. |
| Breaks / manager / approved corrections | Risk to investigate | Employee and manager punches/breaks share atomic operation; corrections use deterministic IDs, actor stamps and overlap checks. Database effective chronology respects approved trims. Live manager/correction workflow still pending. Legacy requests without exact instants require review/resubmission. |
| Wrong app/database deployment | Risk to investigate | Starting GitHub/Vercel/domain/database chain verified. Final SHA and alias pending. |

## Demonstrated root causes and changes

1. Production RPC sorted by inserted_at rather than occurred_at. Older In events uploaded later overrode newer Outs. Three production employees had a different latest ledger status by upload order than their document’s actual-time sequence. Fixed chronological ordering, including effective approved correction times; original ledger rows remain immutable.
2. The RPC ignored the supplied time and substituted server receipt time. A rollback-only production SQL test failed before the repair and passed after it. Original punch instants now survive retries; ambiguous delayed events require review rather than inventing a reconnection time.
3. Opening a cached staff document re-enqueued historical records as new “live” events. Reproduced with the actual ledger module in a VM. Startup now establishes a baseline and only resumes explicitly pending work. Ordinary storage writes compare against the existing log baseline.
4. Failed bootstrap did not install realtime and did not recover on focus. Reproduced with the actual sync module. Recovery now reinstalls realtime and polling, refreshes expired sessions, and preserves edits made during startup reads.
5. The packed Timeclock checked stale local state before handing off, and the outer handoff omitted employee identity. Reproduced by invoking the real packed clock function. Intent/identity now reach the parent first; embedded and standalone fallbacks cannot fabricate employee punches.
6. Open breaks were clamped separately to every future session. They now stop at Clock Out/new In. The real session builder is exercised by runtime tests, not a mirror implementation.
7. Corrections converted date/time in the reviewer’s timezone and generated non-stable materialization IDs. New requests freeze UTC instants/timezone at submission, support overnight work, retain actor and stable correction IDs, and refuse overlaps with other sessions. Native and embedded approval paths were updated.

## Traceability and remaining security limitation

New atomic punches carry employee ID, declared acting employee ID, action source, stable event ID, original instant, server receipt timestamp, Supabase auth session ID and device ID/user-agent. An insert trigger captures receipt/session metadata for all legacy/import writers too. Historical records lacking actor metadata were not retroactively attributed.

**Unresolved:** existing Supabase policies allow anon/authenticated direct attendance INSERT and public SELECT. Staff login is separate from the Supabase anonymous session. A declared acting employee ID is not cryptographic proof of employee identity, and an older/custom client can bypass the new RPC. Closing this safely requires migrating employee authentication/authorization and legacy correction/import writers together. The new audit helps investigation but does not eliminate this security gap. No claim is made that all unauthorized writes are prevented.

## Verification evidence

- Four runtime regressions failed before fixes, then passed.
- Original-time SQL test failed before migration, then passed.
- Same-intent timestamp-order race test failed before the follow-up migration, then passed.
- Three production rollback-only SQL suites verify time preservation, idempotency, chronology, invalid/future/out-of-order rejection, breaks, audit metadata and effective corrections. Confirmed zero diagnostic attendance rows remain.
- 31 runtime/calculation/correction/trim/duration tests passed.
- Seven isolated Chromium browser scenarios passed: slow save with disabled duplicate press; confirmed breaks; two-tab propagation; failed network/reconnect; timeout after server commit; refresh without a new punch; quota failure before request.
- Production build, TypeScript and packed-engine parsing passed before release.
- Full pre-change suite baseline: 508 tests, 494 pass, 14 failures (existing assertions/environment issues). Changed attendance source-pattern assertions also need updating; the full suite is not claimed green. New behavioral evidence above is reported separately.

Browser fault tests use an isolated mock API, not the production account. Database tests use real installed production functions inside transactions that roll back. Neither alone proves a live employee flow; final live evidence is recorded separately below.

## Remaining verification

- Live deliberate In → Break Start → Break End → Out on the user-designated Atheer Jumaah account, with event/document/UI/hour agreement.
- Live automatic synchronization and cache-version upgrade.
- Physical second device, real device sleep/resume and mobile browser cache matrix.
- Live authorized manager and non-self correction approval workflow.
- For historical complaints, employees/event dates are needed to attribute each individual change; legacy audit gaps cannot be invented away.
