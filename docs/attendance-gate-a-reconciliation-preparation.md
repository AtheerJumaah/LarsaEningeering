# Gate A attendance identity reconciliation preparation

**Status:** local review artifact only — no migration file, production permission, production row, sign-in, or deployment was created or changed.

**Baseline:** production project `larsa-control`, reviewed 2026-10-13; application commit `1fdfaebc6ce30270c799bf49b3112dcfafd937ad`.

## 1. Canonical reconciliation matrix

The matrix below is the canonical shape for the enrollment review. The artifact intentionally contains aggregate counts only; employee email addresses and Auth UUIDs must stay in the restricted operator worksheet, not in source control or this document.

| Population / key | Current evidence | Enrollment interpretation | Required disposition |
|---|---:|---|---|
| Current staff rows in `app_state.larsaStaffV8.users` | 35 | Source staff directory; `id` is the immutable Larsa staff key for mapping purposes | Reconcile each row by staff ID, normalized email, enabled/offboarded state |
| Enabled, not-offboarded staff with email | 26 | Eligible population for a controlled Auth enrollment, subject to management approval | Candidate only; do not enroll automatically |
| Enabled staff with blank email | 0 | No current enabled blank-email exception | Keep as invariant in the enrollment check |
| Offboarded staff | 9 | Never enroll; preserve historical attendance and mapping audit | Exclude and test denial |
| Recycled staff rows | 4 | Historical/local lifecycle state, not an enrollment authority | Exclude unless explicitly restored through the account workflow |
| Staff rows with blank email | 6 | All are offboarded; cannot be matched by email | Resolve by immutable ID/history only; never infer an Auth identity |
| Duplicate populated emails in current staff directory | 0 groups / 0 rows | No duplicate current email found in this snapshot | Recheck immediately before enrollment |
| `public.staff_accounts` total | 46 | Durable ledger includes history | Do not use total as current staff count |
| `public.staff_accounts` live / tombstoned | 35 / 11 | Live ledger count agrees with current directory count | Reconcile UID sets before mapping |
| Live `staff_accounts` duplicate normalized emails | 0 groups / 0 rows | No duplicate live ledger email found in this snapshot | Recheck at Gate B |
| `auth.users` total / anonymous | 446 / 445 | Anonymous sessions are not employee identities | Exclude all anonymous users |
| `auth.users` non-anonymous | 1 | Existing non-anonymous user is not presumed to be staff | Identify purpose and explicit owner before any match |
| `public.staff_auth_identity` | Does not exist | No server mapping currently exists | Create only in an approved shadow migration |

### Row-level status vocabulary

The restricted reconciliation worksheet must have one row per current staff UID and these fields:

`staff_uid`, `normalized_staff_email`, `staff_enabled`, `staff_offboarded`, `staff_recycled`, `staff_source` (`app_state`/`staff_accounts`), `auth_user_id` (redacted outside the restricted worksheet), `auth_is_anonymous`, `auth_deleted_at`, `mapping_status`, `match_basis`, `reviewer`, `reviewed_at`, `enrollment_decision`, `blocker`.

Allowed `mapping_status` values:

- `UNREVIEWED` — no operator decision yet.
- `MATCHED_PENDING_ENROLLMENT` — exact staff ID/email review complete; no database mapping written.
- `MATCHED_SHADOW` — mapping exists only after an approved shadow migration and controlled enrollment.
- `BLOCKED_BLANK_EMAIL` — no safe email-based match; requires explicit owner decision.
- `BLOCKED_DUPLICATE_EMAIL` — one email maps to multiple current staff rows.
- `BLOCKED_AUTH_COLLISION` — Auth email/UID already belongs to another approved principal.
- `EXCLUDED_OFFBOARDED` / `EXCLUDED_RECYCLED` — never eligible without an explicit lifecycle restoration decision.
- `REJECTED_MISMATCH` — candidate Auth identity cannot be proven to belong to the staff UID.

## 2. Shadow migration design (design only; not created)

Proposed migration name when implementation is authorized: create it with `supabase migration new attendance_identity_shadow`; do not pre-create a migration file.

### Table contract

`public.staff_auth_identity` should contain:

- `staff_uid text primary key` referencing the immutable Larsa staff ID by application invariant;
- `auth_user_id uuid not null unique` referencing `auth.users(id)` by database foreign key if the deployment policy permits the cross-schema reference;
- `normalized_email text not null` for audit/reconciliation, with a unique active constraint;
- `status text not null` constrained to `active`, `disabled`, or `revoked`;
- `enrolled_at`, `disabled_at`, `revoked_at`, `created_at`, `updated_at` server timestamps;
- `enrolled_by uuid`, `disabled_by uuid`, and a non-secret reason/audit field;
- no password, PIN, access token, or local `larsaStaffV8` blob.

### Security contract

- Enable RLS and default-deny the table.
- Grant no table write to `anon` or `authenticated`.
- Expose only a minimal server-checked mapping/read helper for telemetry; enrollment/disable is service-role/admin controlled.
- Any `SECURITY DEFINER` helper must use `set search_path = pg_catalog, public`, explicitly reject null/anonymous `auth.uid()`, and validate the caller’s mapped role.
- The shadow migration must not alter attendance policies, direct attendance grants, legacy wrappers, or local sign-in behavior.

### Mapping rules

1. Match by immutable staff UID only when the operator has independently established the Auth owner.
2. Use normalized email as a reconciliation signal, never as sole authorization.
3. Require exactly one enabled, non-anonymous Auth user for an enabled staff row.
4. Reject deleted, anonymous, duplicate, reused, or owner-uncertain Auth identities.
5. Offboard/disable mapping before any account can write attendance.
6. Client-supplied `p_uid`, `p_actor_employee_id`, email, name, role, and manager fields remain non-authoritative.

## 3. Rollback SQL outline (not executable SQL)

Rollback must be reviewed as a separate change and run only with explicit approval. The safe Gate A rollback is metadata-only and must not touch attendance data.

1. Disable the shadow feature flag / enrollment path.
2. Revoke execute on any newly introduced enrollment helper from `anon` and `authenticated`; retain service-role/admin access only long enough to inspect audit state.
3. If the shadow table is empty, drop only the newly created mapping helper(s), policies, indexes, and `public.staff_auth_identity` in reverse dependency order.
4. If any mapping row exists, do **not** drop the table automatically. First disable mappings (`status='revoked'`) through the approved operator path, export the redacted audit count, obtain CEO/Board approval, then remove the shadow objects in a separate reviewed change.
5. Do not restore or loosen any attendance grant/policy as part of this rollback; Gate A never changes those objects.
6. Verify afterward with read-only snapshots of `pg_class.relacl`, `pg_policies`, `pg_proc.proacl`, and table counts. Expected result: attendance object snapshots exactly match the pre-gate baseline.

## 4. Test-fixture plan

Fixtures are design-only in this block. No test users, Auth identities, mapping rows, or production rows were created.

### Required fixture identities

- `mapped_self_enabled`: one non-anonymous Auth UID mapped to enabled staff UID `fixture-self`.
- `mapped_disabled`: mapping exists but staff/mapping status is disabled.
- `anonymous_session`: anonymous Supabase session with no mapping.
- `unmapped_nonanonymous`: non-anonymous Auth UID with no mapping.
- `mismatched_client_uid`: mapped session attempts to submit another staff UID.
- `manager_in_scope`: mapped manager with one authorized target scope.
- `manager_out_of_scope`: mapped manager attempting a target outside scope.
- `duplicate_email_candidate`: two staff rows sharing one normalized email; enrollment must stop.
- `blank_email_candidate`: enabled staff row without email; enrollment must stop.
- `auth_collision`: Auth email already owned by a non-staff principal; enrollment must stop.

### SQL assertions

Add `tests/attendance-identity-binding-sql.test.sql` and `tests/attendance-identity-read-scope.test.sql` only when implementation is authorized. Cover:

- mapped self succeeds and derives actor from `auth.uid()`;
- anonymous, unmapped, disabled, revoked, mismatched-UID, and missing-Auth cases fail;
- manager in-scope succeeds; manager out-of-scope fails;
- client actor/name/email/role fields cannot change the server actor;
- event `auth_session_id` and actor are consistent with the mapping;
- idempotency, chronology, append-only behavior, removed-ID handling, and receipt-time preservation remain intact;
- direct `attendance_events` INSERT fails only at the later grant-cutover gate;
- self/manager reads are scoped and cross-team reads fail.

### Runtime/browser assertions

Prepare `tests/staff-auth-enrollment.test.mjs`, `tests/attendance-identity-binding.test.mjs`, and `tests/attendance-auth-browser.smoke.mjs` for:

- real Auth sign-in and mapped staff resolution;
- refresh, tab duplication, sign-out, session expiry, account switching, and access preview;
- local PIN as step-up only, never as server identity;
- Clock In → Clock Out and break flow under a mapped session;
- offline queue behavior: unmapped/disabled writes are hard failures, not replayable bypasses;
- correction/manager authorization and no client UID authority.

## 5. Unresolved mapping questions

1. Who owns the single existing non-anonymous Auth user, and is it a viewer/admin account rather than an employee?
2. Should controlled enrollment use native Supabase email/password, magic link, or OTP? Existing local PBKDF2 hashes cannot be imported as Supabase password hashes.
3. What approved enrollment exists for the 26 enabled employees who lack a mailbox or cannot receive email, if any?
4. Is `u1` (Atheer’s designated test employee) approved as the first canary, and which Auth account will be used without exposing credentials in source control?
5. What server-owned table defines manager/team/department scope? Current local role and org JSON is not sufficient authorization data.
6. What is the required retention/audit policy for enrollment, disable, re-enable, and Auth account reassignment?
7. What is the service-worker/cache retirement window before the legacy `attendance_punch` execute grant can be revoked?
8. How should the six offboarded blank-email records and the eleven tombstoned `staff_accounts` records be reconciled without guessing identity?
9. Who may approve a mapping correction, and what evidence is required when staff email and Auth email differ?

## Gate A disposition

The matrix is internally consistent for current rows (35 staff, 26 eligible by status, zero current duplicate-email groups), but identity enrollment is not ready: 445 Auth users are anonymous, the one non-anonymous account is unclassified, and no server mapping exists. The next safe gate is an operator-reviewed, redacted row-level reconciliation and written answers to the questions above. No shadow migration or permission cutover should begin until those artifacts receive explicit CEO/Board approval.
