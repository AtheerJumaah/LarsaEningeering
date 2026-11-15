import { isActiveClockSession } from './attendance.mjs';
import { attendanceWeekdayIndex } from './attendance-timezone.mjs';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Presence dashboards count a person once when any of today's shifts expects attendance. */
export function scheduledPresenceUsers(schedule, instant) {
  const day = WEEKDAYS[attendanceWeekdayIndex(instant)];
  const scheduled = new Set();
  if (!day || !schedule || typeof schedule !== 'object') return scheduled;
  for (const [uid, week] of Object.entries(schedule)) {
    const shifts = week?.[day];
    if (Array.isArray(shifts) && shifts.some((entry) => {
      const code = String(entry?.code || '').trim().toUpperCase();
      return code && code !== 'OFF' && code !== 'STB';
    })) scheduled.add(uid);
  }
  return scheduled;
}

/** Shared with the existing employee list: one current state per enabled account. */
export function buildPresenceRoster(users, sessions, classifyMode) {
  const openByUser = new Map();
  for (const session of sessions) {
    if (session.open && !openByUser.has(session.uid)) openByUser.set(session.uid, session);
  }
  const seen = new Set();
  return users.filter(user => {
    if (user.enabled === false || !user.id || seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  }).map(user => {
    const openSession = openByUser.get(user.id);
    const isIn = isActiveClockSession(openSession);
    return {
      user, isIn,
      tone: isIn ? classifyMode(openSession.mode) : 'off',
      stale: Boolean(openSession?.stale),
    };
  });
}

const TONE_ORDER = { office: 0, online: 1, site: 2, other: 3, off: 4 };

/** Three positions per ray, inner to outer, clockwise. Never create placeholder people. */
export function layoutPresenceLights(people) {
  const ordered = [...people].sort((a, b) =>
    TONE_ORDER[a.tone] - TONE_ORDER[b.tone]
    || a.user.name.localeCompare(b.user.name)
    || a.user.id.localeCompare(b.user.id));
  // Grow capacity by four rays, retaining an open arc until those positions are occupied.
  const rays = Math.max(12, Math.ceil(ordered.length / 12) * 4);
  const dotRadius = Math.min(3.4, 34 * Math.sin(Math.PI / rays) * 0.7);
  return ordered.map((person, index) => {
    const row = index % 3;
    const ray = Math.floor(index / 3);
    const angle = -Math.PI / 2 + ray * 2 * Math.PI / rays;
    const radius = 34 + row * 14;
    return { ...person, row, ray, dotRadius,
      x: Number((72 + Math.cos(angle) * radius).toFixed(3)),
      y: Number((72 + Math.sin(angle) * radius).toFixed(3)),
    };
  });
}
