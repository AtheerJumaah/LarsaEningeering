import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPresenceRoster, layoutPresenceLights } from '../lib/presence.mjs';

const classify = mode => ({ Office: 'office', Online: 'online', Site: 'site' })[mode] || 'other';
const user = (id, enabled = true) => ({ id: String(id), name: `Employee ${id}`, enabled });
const entry = (id, tone = 'off') => ({ user: user(id), tone, isIn: tone !== 'off' });

test('one light per enabled employee; added, removed, disabled and duplicate accounts', () => {
  for (const count of [0, 1, 2, 3, 12, 29, 35, 36, 37, 60, 120]) {
    const users = Array.from({ length: count }, (_, i) => user(i));
    const people = buildPresenceRoster([...users, ...users, user('disabled', false)], [], [], classify);
    assert.equal(layoutPresenceLights(people).length, count);
    assert.equal(new Set(people.map(person => person.user.id)).size, count);
    assert.equal(layoutPresenceLights(buildPresenceRoster(users.slice(1), [], [], classify)).length, Math.max(0, count - 1));
  }
});

test('three lights fill one ray before moving clockwise; empty capacity has no lights', () => {
  const lights = layoutPresenceLights(Array.from({ length: 29 }, (_, i) => entry(i)));
  assert.equal(lights.length, 29);
  assert.deepEqual(lights.slice(0, 4).map(light => [light.ray, light.row]), [[0, 0], [0, 1], [0, 2], [1, 0]]);
  assert.equal(lights[0].x, 72);
  assert.ok(lights[0].y > lights[1].y && lights[1].y > lights[2].y);
  assert.ok(lights[3].x > lights[0].x);
  assert.equal(lights.at(-1).ray, 9);
  assert.equal(lights.at(-1).row, 1);
  assert.ok(lights.every(light => light.ray < 10));
});

test('larger teams stay inside the viewbox with separate dots and three rows', () => {
  for (const count of [36, 37, 100, 400]) {
    const lights = layoutPresenceLights(Array.from({ length: count }, (_, i) => entry(i)));
    assert.equal(lights.length, count);
    for (let i = 0; i < lights.length; i++) {
      const a = lights[i];
      assert.ok(a.row >= 0 && a.row < 3 && a.x > a.dotRadius && a.x < 144 - a.dotRadius && a.y > a.dotRadius && a.y < 144 - a.dotRadius);
      for (const b of lights.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.dotRadius + b.dotRadius);
    }
  }
});

test('office, home, site, offline and unknown location use the existing attendance state', () => {
  const users = [user('office'), user('home'), user('site'), user('offline'), user('unknown')];
  const sessions = ['office', 'home', 'site', 'unknown'].map((uid, i) => ({ uid, open: true, mode: ['Office', 'Online', 'Site', ''][i], clockIn: '2026-11-15T08:00:00Z', presenceHours: 2 }));
  const people = buildPresenceRoster(users, [], sessions, classify);
  assert.deepEqual(people.map(p => p.tone), ['office', 'online', 'site', 'off', 'other']);
  assert.equal(people.filter(p => p.isIn).length, 4);
  assert.deepEqual(layoutPresenceLights(people).map(p => p.tone), ['office', 'online', 'site', 'other', 'off']);
});

test('stale and abandoned open punches remain offline; latest clock-out removes active light', () => {
  const users = [user('stale'), user('abandoned'), user('out'), user('fallback')];
  const logs = users.flatMap(u => [{ uid: u.id, status: 'In', type: 'Office', time: '2026-11-15T08:00:00Z' }]);
  logs.unshift({ uid: 'out', status: 'Out', time: '2026-11-15T09:00:00Z' });
  const sessions = [{ uid: 'stale', open: true, stale: true, mode: 'Office' }, { uid: 'abandoned', open: true, unclosed: true, mode: 'Site' }];
  const people = buildPresenceRoster(users, logs, sessions, classify);
  assert.deepEqual(people.map(p => p.tone), ['off', 'off', 'off', 'office']);
  assert.equal(people[0].stale, true);
});

test('status changes update the same employees without mutating roster or attendance', () => {
  const users = [user('a'), user('b')];
  const logs = [{ uid: 'a', status: 'In', type: 'Office', time: '2026-11-15T08:00:00Z' }];
  const before = JSON.stringify({ users, logs });
  const first = buildPresenceRoster(users, logs, [], classify);
  layoutPresenceLights(first);
  assert.equal(JSON.stringify({ users, logs }), before);
  const second = buildPresenceRoster(users, [...logs, { uid: 'a', status: 'Out', time: '2026-11-15T10:00:00Z' }], [], classify);
  assert.equal(first[0].tone, 'office');
  assert.equal(second[0].tone, 'off');
  assert.deepEqual(second.map(p => p.user.id), first.map(p => p.user.id));
});
