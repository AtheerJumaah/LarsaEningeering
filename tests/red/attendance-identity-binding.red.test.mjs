/* EXPECTED RED CONTRACT TEST
 *
 * Run explicitly with:
 *   node --test tests/red/attendance-identity-binding.red.test.mjs
 *
 * This file is intentionally outside the default npm test glob. It documents
 * the behavior that must fail against the current client-supplied identity
 * implementation and pass only after the approved identity-binding work.
 * It reads local source only and never contacts Supabase or production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identityBindingCases } from '../fixtures/attendance-identity-fixtures.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const punch = read('lib/attendance-punch.ts');
const ledger = read('lib/ledger.ts');
const page = read('app/page.tsx');
const accounts = read('lib/accounts-ledger.ts');

test('[RED GATE B-APP-001] attendance writer requires a non-anonymous Auth user', () => {
  assert.match(punch, /export function attendanceAuthBindingEnabled\(\)/,
    'Auth binding must be controlled by an explicit build-time flag');
  assert.match(punch, /if \(attendanceAuthBindingEnabled\(\)\) \{/,
    'the enabled branch must be discoverable');
  assert.match(punch, /getUser\s*\(/, 'writer must inspect the authenticated user, not only getSession');
  assert.match(punch, /is_anonymous|anonymous/i, 'writer must reject anonymous sessions explicitly');
  const strictBranch = punch.slice(
    punch.indexOf('if (attendanceAuthBindingEnabled())'),
    punch.indexOf('} else {', punch.indexOf('if (attendanceAuthBindingEnabled())')),
  );
  assert.doesNotMatch(strictBranch, /signInAnonymously\s*\(/,
    'enabled Auth binding must never fall back to anonymous Auth');
});

test('[RED GATE B-APP-002] direct attendance ledger upsert is removed', () => {
  assert.doesNotMatch(ledger, /from\(["']attendance_events["']\)[\s\S]{0,240}\.upsert\s*\(/,
    'all attendance writes must use a server-authorized operation');
});

test('[RED GATE B-APP-003] staff sign-out clears the real Auth session', () => {
  const match = page.match(/const signOut = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[\]\);/);
  assert.ok(match, 'staff sign-out callback must remain discoverable');
  assert.match(match[1], /auth\.signOut\s*\(/, 'staff sign-out must also terminate Supabase Auth');
});

test('[RED GATE B-APP-004] account-ledger actor is server-derived', () => {
  assert.doesNotMatch(accounts, /p_by\s*:\s*by\b/, 'client-supplied p_by must not authorize account changes');
  assert.match(accounts, /p_by\s*:\s*actor\.authUserId/);
  assert.match(accounts, /client\.auth\.getUser\(\)/);
});

for (const fixture of identityBindingCases) {
  test(`[RED GATE B-SYN-${fixture.id}] ${fixture.name} has an explicit expected outcome`, () => {
    assert.ok(fixture.session, 'fixture must include a synthetic session');
    assert.ok(fixture.expected?.outcome, 'fixture must define authorized/forbidden expectation');
    if (fixture.expected.outcome === 'forbidden') assert.match(fixture.expected.reason, /^[a-z_]+$/);
  });
}
