# Identity-binding red test report

**Scope:** local synthetic fixtures and failing contract plans only.
**Baseline:** commit `1fdfaebc6ce30270c799bf49b3112dcfafd937ad`.
**Production state:** unchanged; no Auth, mapping, permission, migration, or attendance data operation was performed.

## Artifacts

- `tests/fixtures/attendance-identity-fixtures.mjs` — synthetic staff, Auth, session, authorization, and enrollment cases. All identifiers use `example.test` or reserved UUIDs.
- `tests/red/attendance-identity-binding.red.test.mjs` — gated local source-contract tests. It is outside the default `npm test` glob and makes no network calls; the app contracts now pass, while the SQL plan remains intentionally red.
- `tests/red/attendance-identity-binding.red.sql` — intentionally red read-only schema/ACL contract plan. It is not included in the SQL runner and must never be run against production.
- `tests/account-ledger-runtime.test.mjs` — synthetic Auth/queue/tombstone runtime coverage; no real identity, PII, or network.
- `docs/attendance-auth-binding-rollout-rollback.md` — production-default-OFF compatibility flag, fail-closed enabled path, rollout gates, and rollback design.

## Current red/green status after the local implementation blocks

The first two approved local fixes are now implemented and their contracts pass:

- `lib/attendance-punch.ts` has an explicit `NEXT_PUBLIC_LARSA_ATTENDANCE_AUTH_BINDING` build-time switch. When enabled it requires `auth.getUser()`, rejects anonymous/missing identities, preserves transient Auth/network failures as retryable, and never calls `signInAnonymously()` in that strict branch. When unset/false it preserves the existing anonymous bootstrap for compatibility while the reliability fixes remain active.
- Staff `signOut` starts Supabase `auth.signOut()` while clearing the local shell immediately, so a remote failure cannot leave this browser displaying the staff session.

Local implementation files changed across these blocks:

- `lib/attendance-punch.ts`
- `app/page.tsx`
- `tests/attendance-runtime.test.mjs`
- `tests/attendance-queue-runtime.test.mjs`
- `tests/notifications.test.mjs` (made the existing sign-out contract slice resilient to the added Auth cleanup)
- `lib/ledger.ts` (attendance writes cross the explicit RPC operation boundary)
- `lib/accounts-ledger.ts` (account writes require non-anonymous Auth; legacy audit actor is the verified Auth UUID)
- `tests/account-ledger.test.mjs`
- `tests/account-ledger-runtime.test.mjs`
- `tests/ledger-writer-runtime.test.mjs`
- `tests/durable-ledger.test.mjs`

The forbidden path preserves the original event in `larsaAttendancePunchDeniedV1:<actor>` for review, removes it from the retry queue, and does not call the attendance RPC. Transient Auth/network failures remain `unavailable` and retain the existing retry queue behavior.

Verification completed locally:

- Full local default suite: **595 passed, 0 failed**.
- Red behavioral contract suite: **11 passed, 0 failed**.
- Account-ledger/attendance-ledger focused runtime and contract suites: **26 passed, 0 failed**.
- `node --check` passed for the synthetic fixture and red behavioral test.
- TypeScript no-emit check completed with no diagnostics.

The account-ledger boundary now has the same safe behavior: a missing, anonymous,
or unavailable Auth identity leaves queued account upserts pending; tombstone and
untombstone APIs no longer accept a caller-supplied actor. The legacy `p_by`
parameter, where the current RPC still requires it, is populated only from the
verified Auth UUID after `auth.getUser()`. The app permanent-delete path passes a
reason only; it cannot choose the actor.

The explicit red behavioral plan now passes all local app/fixture contracts. It is
still a client-side safety boundary, not proof of production server authorization.

The direct ledger upsert finding is addressed locally: `lib/ledger.ts` now
submits one event at a time through the named `record_attendance_action` RPC
boundary, consumes only `recorded`/`already` responses, and retains all later
events when the boundary is unavailable. This remains a compatibility bridge,
not server identity authorization; production grant removal still requires the
approved Auth-to-staff mapping and server-derived replay/import operation. The
account ledger has the same prerequisite: its three legacy account RPCs must
derive and verify the actor from `auth.uid()` (including role/scope) before
their direct grants are removed.

The SQL plan should fail against the current schema because:

1. `public.staff_auth_identity` is absent.
2. `current_staff_uid()` is absent.
3. The attendance writer now requires a non-anonymous Auth user locally, but it is not yet server-bound to a production identity mapping.
4. Later Gate E privilege assertions still detect direct attendance INSERT grants; this is expected and must not be fixed during Gate B.

## Execution gates

- The default repository test command must remain green; these red plans are not part of it.
- The red behavioral plan may be run locally with `node --test tests/red/attendance-identity-binding.red.test.mjs` to verify the local app/fixture gates.
- The SQL plan is a review artifact only until an isolated database, approved migration, synthetic fixtures, and rollback procedure exist.
- No real employee PII may be substituted into the fixtures. The unknown production Auth user must not be classified by these tests.
- Red failures are evidence of missing implementation, not permission to edit production or weaken the expected assertions.
