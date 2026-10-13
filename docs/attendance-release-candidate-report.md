# Attendance identity-binding release-candidate report

**Owner:** CTO / Engineering Director
**Requested by:** CEO / Chief of Staff (`/root`)
**Baseline:** `1fdfaebc6ce30270c799bf49b3112dcfafd937ad` (`Guard intent-free attendance punches`)
**Candidate state:** local commit `1d24435ba8e569fbe313dc5b34323e4fea9d8ebb` on `release/attendance-compat-default-off`; not pushed. No deployment, migration execution, production grant change, Auth enrollment, or production data change.

## Decision

The accumulated changes are release-candidate quality for local review, but **NO-GO for production release** until the server identity-binding and authorization gates below are completed and separately approved. The local app/fixture contracts are green; that does not prove production `auth.uid()` mapping or server-side role enforcement.

## Exact candidate file manifest

Modified application and test files:

- `app/page.tsx`
- `lib/accounts-ledger.ts`
- `lib/attendance-punch.ts`
- `lib/ledger.ts`
- `tests/account-ledger.test.mjs`
- `tests/attendance-browser.smoke.mjs`
- `tests/attendance-queue-runtime.test.mjs`
- `tests/attendance-runtime.test.mjs`
- `tests/durable-ledger.test.mjs`
- `tests/notifications.test.mjs`

New local test/fixture files:

- `tests/account-ledger-runtime.test.mjs`
- `tests/ledger-writer-runtime.test.mjs`
- `tests/fixtures/attendance-identity-fixtures.mjs`
- `tests/red/attendance-identity-binding.red.test.mjs`
- `tests/red/attendance-identity-binding.red.sql`

New local engineering and decision artifacts:

- `docs/engineering-org-and-sop.md`
- `docs/attendance-identity-binding-plan.md`
- `docs/attendance-gate-a-reconciliation-preparation.md`
- `docs/attendance-gate-a-decision-package-atheer.md`
- `docs/attendance-ceo-signoff-1fdfaeb.md`
- `docs/attendance-identity-binding-red-test-report.md`
- `docs/attendance-auth-binding-rollout-rollback.md`
- `docs/attendance-production-proof-2026-10-12.jpg`
- `docs/attendance-release-candidate-report.md`

No migration file is modified or added by this candidate. The SQL file above is a read-only expected-red contract and must not be run against production.

## Verification record

- `node --test tests/*.test.mjs`: **595 passed, 0 failed**.
- `node --test tests/red/attendance-identity-binding.red.test.mjs`: **11 passed, 0 failed**.
- `tsc --noEmit --pretty false`: passed with no diagnostics.
- `git diff --check`: clean after the documentation-only whitespace cleanup; Git may still print Windows LF/CRLF normalization notices, which are not content warnings.
- `node --check` for the new runtime and red tests: passed.
- `node_modules/.bin/next.CMD build`: completed successfully; static routes `/` and `/_not-found` generated.
- Local browser/API smoke (`tests/attendance-browser.smoke.mjs`) against `http://127.0.0.1:5199/` with Playwright-intercepted synthetic `fixture.supabase.co` Auth/RPC endpoints: **9 scenarios passed, 0 failed**.

The local checks cover both modes of the attendance Auth-binding flag: default-OFF anonymous compatibility and explicit-ON non-anonymous fail-closed behavior. They also cover Auth-derived account audit actor, account/RPC queue retry retention, attendance RPC boundary use, sign-out Auth cleanup, and synthetic mapped/unmapped/anonymous/disabled/scope cases.

## Preview authorization gate and command checklist

The sole external dependency is Vercel preview authorization. The authenticated connector can see the `larsa-eningeering` project (`prj_bKC7SSpWkrYs9LuZIii8X2aFcWqk`) in team `team_lg17gfhawQFaFbcXXzRUBvIH`, but it currently lacks the effective permission to create and list/inspect deployments. The API returned HTTP 403 for both `POST /v13/deployments` and deployment listing. No preview URL exists. A Vercel account/connector with project-scoped preview deployment create plus deployment list/inspect permission is required; do not broaden production permissions to satisfy this gate.

After that permission is granted, run this checklist from a clean checkout of commit `1d24435ba8e569fbe313dc5b34323e4fea9d8ebb`:

```powershell
$team = "team_lg17gfhawQFaFbcXXzRUBvIH"
$project = "larsa-eningeering"
git status --short
git show --no-patch 1d24435ba8e569fbe313dc5b34323e4fea9d8ebb
vercel --scope $team link --project $project --yes
vercel --scope $team env ls preview
vercel --scope $team deploy . --target preview --yes
```

The preview environment must leave `NEXT_PUBLIC_LARSA_ATTENDANCE_AUTH_BINDING` unset or explicitly false; never enable it for this compatibility release. Do not print unrelated environment values. Record the returned preview hostname and verify it with the synthetic browser smoke:

```powershell
$env:SMOKE_URL = "https://<preview-host>/"
node tests/attendance-browser.smoke.mjs
```

If the preview artifact must be backed out before production approval, redeploy the last approved commit to a new preview target with `--target preview`; do not delete rows or change grants. A production rollback command such as `vercel --scope $team rollback <known-good-production-deployment-url>` is a separate, explicitly authorized production gate and must not be run as part of this release block.

## Browser/API smoke details

The smoke run recorded all of the following on the local candidate, with no real employee account or production URL:

1. One slow deliberate Clock In enters Saving and does not duplicate.
2. Break Start and Break End are server-confirmed.
3. A second tab reflects Clock Out without a reload.
4. An offline action remains pending, then reconnect retries the same event ID and original time.
5. A timeout after server commit retries idempotently without a duplicate.
6. Refresh preserves the final status and does not create a punch.
7. Storage quota failure prevents an unsafe punch.
8. A deliberate Clock Out during a slow save queues once and confirms in order.
9. Sign-out clears `larsa-control-session` and calls the intercepted Supabase Auth logout endpoint.

Two initial observations were test-harness conditions, not product regressions: the first run lacked synthetic Supabase environment variables, so the expected local RPC path was disabled; after providing fake values, the immediate disabled-state assertion raced React's render commit, and the delayed-RPC assertion raced the intentionally 9.5-second fixture response. The harness now waits for the rendered disabled state and intercepted event count. The rerun passed all nine scenarios.

## Evidence that production was not touched

- The release branch is clean at commit `1d24435ba8e569fbe313dc5b34323e4fea9d8ebb`; the original commit remains unchanged and has not been pushed.
- `git diff --name-only` contains no `supabase/migrations/`, `.env*`, deployment, CI, or platform configuration path.
- The candidate tests use local source inspection, VM-transpiled modules, synthetic `example.test` identities, and reserved UUIDs. They make no Supabase or production network calls.
- The build ran locally and produced no tracked source changes.
- No production rows, permissions, Auth identities, grants, migrations, sign-in behavior, or deployments were altered.

## Rollback plan

### Before any authorized release

1. Preserve this working tree as a review snapshot or dedicated release branch; do not use `git reset --hard` against the shared workspace.
2. If review rejects the candidate, revert only the listed application/test/documentation patch through an approved patch or restore the pre-candidate snapshot. Leave unrelated user work untouched.
3. Re-run the full 595-test suite and type/build checks after any rollback or selective revert.

### If a later production rollout is authorized

1. Disable the identity-binding feature flag/canary and stop new enforcement first.
2. Restore the last known-good application/RPC version based on the deployed SHA, without reopening direct table writes or bypassing the audit path.
3. Preserve queued punches/account writes and reconcile them through the audited operation; never delete or rewrite attendance rows to hide a failed rollout.
4. If a database migration is ever approved, use its separately reviewed rollback SQL only in the isolated migration runner first; production rollback requires an explicit database gate and snapshot verification.
5. Trigger rollback for any unexplained 401/403, missing/duplicate event, document/ledger mismatch, unauthorized target write, queue loss, or material latency regression.

## Remaining production prerequisites and NO-GO items

1. Complete and approve the canonical staff/Auth reconciliation. Do not classify the unknown production Auth user or enroll real employees from synthetic tests.
2. Add and validate the shadow `public.staff_auth_identity` mapping, one-to-one Auth UID/staff UID constraints, RLS/default deny, and server helpers such as `current_staff_uid()`.
3. Replace `record_attendance_action` authorization with server-derived `auth.uid()` mapping, self/manager scope checks, idempotency, chronology, and append-only audit behavior.
4. Update `staff_account_upsert`, `staff_account_tombstone`, and `staff_account_untombstone` to derive/verify actor and role server-side. The client-side Auth gate is only a compatibility safety boundary.
5. Migrate/review all non-live writers and replay/import paths, then prove offline queues do not bypass authorization.
6. Run the SQL contract suite against an isolated shadow database, including anonymous, unmapped, disabled, mismatched, manager-scope, RLS, function-security, and privilege cases; test rollback there.
7. Only after Gates A–D pass, revoke direct `attendance_events` INSERT grants and broad policies, narrow reads, and retire legacy writer execution after the agreed cache/telemetry window.
8. Establish a controlled real Auth canary, repeat the authenticated Clock In → Clock Out proof on the deployed SHA, and monitor 24 hours for auth failures, queue growth, duplicates, timeouts, and unmapped writes.

Until these prerequisites are approved and verified, the correct production statement remains: **behaviorally audited attendance with a client-side identity boundary; not yet cryptographically server-bound employee attendance.**
