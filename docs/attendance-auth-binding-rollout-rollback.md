# Attendance Auth-binding rollout and rollback design

**Status:** local design and tests only. No deployment, migration, grant, Auth enrollment, or production change is authorized.

## Decision

The reliability fixes can ship independently of identity enforcement by gating only the attendance writer's Auth-binding requirement behind the build-time flag:

`NEXT_PUBLIC_LARSA_ATTENDANCE_AUTH_BINDING`

The flag is **OFF when unset or unrecognized**. OFF preserves the existing local-PIN plus anonymous Supabase bootstrap path so current attendance is not interrupted. The reliability changes remain active: server RPC boundary, stable event IDs, timeout handling, durable queue/retry, idempotency, and server-time behavior.

When explicitly enabled (`1`, `true`, `on`, or `enabled`), the writer uses `auth.getUser()` and fails closed:

- missing or anonymous user → `forbidden`, held for review by the existing caller, and no RPC;
- transient Auth-service failure → `unavailable`, retained for retry;
- non-anonymous user → RPC attempt, subject to server-side authorization;
- no `signInAnonymously()` fallback in the enabled branch.

The flag is build-time only. It is not read from localStorage, query parameters, or a remote client-editable setting. A device cannot turn enforcement off for itself. The account-ledger Auth hardening remains fail-closed and is intentionally not put behind this attendance compatibility switch because its removed client `p_by` actor path has no safe anonymous fallback.

## Behavior matrix

| Build flag | Auth state | Client result | Queue behavior | RPC |
|---|---|---|---|---|
| unset/false | no session | legacy bootstrap attempt | existing retry behavior | anonymous sign-in then RPC |
| unset/false | existing anonymous session | legacy-compatible write | existing retry behavior | RPC |
| enabled | missing/anonymous | `forbidden` | held for review, removed from retry queue | none |
| enabled | Auth lookup transient error | `unavailable` | remains pending | none |
| enabled | non-anonymous user | proceeds to operation boundary | existing retry behavior | server RPC |

## Rollout gates

1. **Local gate:** run both flag modes with synthetic Auth fixtures; verify the full reliability suite, identity red contracts, type-check, build, and local browser/API smoke.
2. **Staging gate:** build with the flag enabled against an isolated Supabase project containing the shadow Auth-to-staff mapping and server-authorized RPC. Verify mapped, anonymous, unmapped, disabled, mismatched, and manager-scope cases.
3. **Canary gate:** enable only in a separately built canary artifact for an explicitly enrolled test account. Confirm refresh, reconnect, sign-out, account switching, two tabs, offline queue, and Clock In → Clock Out proof. Require zero unauthorized writes and zero queue loss.
4. **Cohort gate:** expand to an approved cohort while monitoring 401/403, 5xx/timeout, pending queue depth, forbidden-review count, duplicate event IDs, and document/ledger parity.
5. **Enforcement gate:** only after the server mapping/RPC and canary gates pass may production identity enforcement be considered. This flag does not authorize grant revocation or migrations.

## Rollback

- **Before enabling:** leave the production flag unset; the release remains in compatibility mode.
- **Canary failure:** stop cohort expansion and deploy the previously approved artifact with the flag OFF. This is an application-artifact rollback only; do not alter database grants or rows.
- **Enabled artifact outage:** roll back to the last known-good artifact with the flag OFF, preserve queued events, and reconcile any held-for-review punches through the approved correction process.
- **Server authorization failure:** keep the flag enabled only if the intended fail-closed behavior is acceptable; otherwise roll back the artifact. Never restore direct table writes or client actor authority as an emergency shortcut.
- **Database rollback:** no database rollback is part of this flag design. Any future identity migration requires its own isolated rollback SQL, approval, and privilege gate.

Because the flag is build-time, changing it requires selecting/rebuilding/deploying an approved artifact. A browser-side toggle is intentionally not available. Rollback success criteria are: no anonymous punch is silently promoted under the enabled artifact, no queued event is discarded, and the compatibility artifact restores the prior anonymous path without changing stored rows.

## Local tests

- `tests/attendance-runtime.test.mjs`: OFF-mode anonymous bootstrap, OFF-mode existing anonymous session, enabled-mode anonymous denial, enabled-mode non-anonymous success, transient Auth handling, timeout, and late-auth cancellation.
- `tests/red/attendance-identity-binding.red.test.mjs`: strict branch contains `getUser()` and no anonymous fallback while remaining explicit about the compatibility flag.
- `tests/attendance-browser.smoke.mjs`: local synthetic API interception continues to validate queue/reconnect/sign-out behavior with the compatibility flag unset.

## NO-GO conditions

- Do not enable the flag in production before real Auth enrollment/mapping and server-side `auth.uid()` authorization exist.
- Do not treat a non-anonymous Auth user alone as sufficient authorization; mapping, enabled status, role, target scope, chronology, and idempotency remain server responsibilities.
- Do not use localStorage, a query parameter, or a client role to override the flag.
- Do not deploy, migrate, revoke grants, enroll real users, or classify the unknown production Auth user as part of this design block.
