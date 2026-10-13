/* Static contract tests for the synthetic staging attendance artifact.
 * These tests never contact Supabase and never use production identifiers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = read('supabase/staging/attendance_identity_contract.sql');
const rollback = read('supabase/staging/attendance_identity_contract_rollback.sql');
const fixtures = read('tests/fixtures/attendance-identity-fixtures.mjs');

test('staging contract is explicitly isolated from production', () => {
  assert.match(contract, /STAGING-ONLY ATTENDANCE IDENTITY CONTRACT/);
  assert.doesNotMatch(contract, /larsaeng\.app|larsa-control|production\s+grant/i);
  assert.match(contract, /example\.test/);
  assert.match(contract, /No auth\.users rows are inserted/);
  assert.match(rollback, /STAGING-ONLY ROLLBACK/);
});

test('identity binding is unique, enabled-gated, and synthetic-only', () => {
  assert.match(contract, /create table if not exists public\.staff_auth_identity/);
  assert.match(contract, /auth_user_id uuid primary key/);
  assert.match(contract, /staff_uid text not null unique/);
  assert.match(contract, /enabled boolean not null default true/);
  assert.match(contract, /role text not null default 'employee'/);
  assert.match(contract, /manager_team_ids text\[\] not null/);
  assert.match(contract, /00000000-0000-4000-8000-000000000001/);
  assert.match(contract, /00000000-0000-4000-8000-000000000002/);
  assert.match(fixtures, /example\.test/);
  assert.doesNotMatch(contract, /auth\.users\s*\(/i);
});

test('attendance table is RLS-protected, append-only, and has no client table grants', () => {
  assert.match(contract, /create table if not exists public\.attendance_events/);
  assert.match(contract, /client_event_id text not null unique/);
  assert.match(contract, /alter table public\.attendance_events enable row level security/);
  assert.match(contract, /alter table public\.attendance_events force row level security/);
  assert.match(contract, /revoke all on table public\.attendance_events from public, anon, authenticated/);
  assert.match(contract, /attendance_events_append_only/);
  assert.match(contract, /before update or delete on public\.attendance_events/);
});

test('RPC derives actor from Auth, enforces self/manager scope, and preserves chronology', () => {
  assert.match(contract, /v_auth_uid uuid := \(select auth\.uid\(\)\)/);
  assert.match(contract, /Authenticated user has no enabled staff mapping/);
  assert.match(contract, /v_identity\.role = 'manager'/);
  assert.match(contract, /v_target\.team_id = any\(v_identity\.manager_team_ids\)/);
  assert.match(contract, /perform pg_advisory_xact_lock/);
  assert.match(contract, /where e\.client_event_id = p_client_event_id/);
  assert.match(contract, /p_occurred_at < v_current\.occurred_at/);
  assert.match(contract, /actor_employee_id, auth_session_id/);
  assert.match(contract, /v_actor\.uid, v_auth_uid/);
  assert.match(contract, /grant execute on function public\.record_attendance_action/);
  assert.doesNotMatch(contract, /grant execute on function public\.record_attendance_action[\s\S]{0,220} to anon/);
});

test('rollback is bounded to contract objects and test artifact is synthetic', () => {
  assert.match(rollback, /drop table if exists public\.attendance_events/);
  assert.match(rollback, /drop table if exists public\.staff_auth_identity/);
  assert.match(rollback, /drop table if exists public\.staff_accounts/);
  assert.doesNotMatch(rollback, /drop table if exists public\.(app_state|acct_)/);
  assert.match(fixtures, /fixture-staff-self-001/);
  assert.match(fixtures, /fixture-staff-manager-001/);
});
