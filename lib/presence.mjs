import { isActiveClockSession } from './attendance.mjs';

/** Shared with the existing employee list: one current state per enabled account. */
export function buildPresenceRoster(users, logs, sessions, classifyMode) {
  const latestByUser = new Map();
  for (const log of logs) {
    if (!log.uid || !log.time) continue;
    const previous = latestByUser.get(log.uid);
    if (!previous || new Date(log.time).getTime() > new Date(previous.time).getTime()) {
      latestByUser.set(log.uid, log);
    }
  }
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
    const latest = latestByUser.get(user.id);
    const openSession = openByUser.get(user.id);
    const activeSession = isActiveClockSession(openSession);
    const isIn = activeSession || (!openSession && latest?.status === 'In');
    const mode = activeSession ? openSession.mode || '' : !openSession ? latest?.type || '' : '';
    return {
      user, isIn,
      tone: isIn ? classifyMode(mode) : 'off',
      mode: mode || '-',
      since: activeSession ? openSession.clockIn || '' : !openSession ? latest?.time || '' : '',
      hours: activeSession ? openSession.presenceHours || 0 : 0,
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
