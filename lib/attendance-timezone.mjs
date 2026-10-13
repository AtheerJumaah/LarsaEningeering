/* Canonical attendance calendar helpers.
 *
 * Punches remain UTC instants. These helpers only decide which calendar day
 * an instant belongs to and where a session crosses a local midnight. The
 * zone is deliberately isolated here so the owner can change the one policy
 * constant without scattering browser-local Date math through the attendance
 * screens.
 */
export const ATTENDANCE_TIME_ZONE = "America/Chicago";

const formatterCache = new Map();

function formatter(timeZone) {
  const key = String(timeZone || ATTENDANCE_TIME_ZONE);
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.DateTimeFormat("en-CA", {
      timeZone: key,
      year: "numeric", month: "2-digit", day: "2-digit",
    }));
  }
  return formatterCache.get(key);
}

export function validAttendanceTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(timeZone) });
    return true;
  } catch {
    return false;
  }
}

export function attendanceDateKey(instant, timeZone = ATTENDANCE_TIME_ZONE) {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(ms)) return "";
  const zone = validAttendanceTimeZone(timeZone) ? timeZone : ATTENDANCE_TIME_ZONE;
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (name) => parts.find((part) => part.type === name)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function attendanceMonthKey(instant, timeZone = ATTENDANCE_TIME_ZONE) {
  return attendanceDateKey(instant, timeZone).slice(0, 7);
}

export function attendanceWeekdayIndex(instant, timeZone = ATTENDANCE_TIME_ZONE) {
  const key = attendanceDateKey(instant, timeZone);
  return key ? new Date(`${key}T12:00:00Z`).getUTCDay() : NaN;
}

/* The ISO week belongs to the canonical calendar date, not the browser's
 * calendar date. The UTC noon construction avoids DST affecting week math. */
export function attendanceWeekKey(instant, timeZone = ATTENDANCE_TIME_ZONE) {
  const key = attendanceDateKey(instant, timeZone);
  if (!key) return "";
  const date = new Date(`${key}T12:00:00Z`);
  const target = new Date(date);
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function addCalendarDay(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function attendanceDateOffset(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

/* Convert a wall-clock midnight in an IANA zone into its UTC instant. The
 * short fixed-point loop handles normal offsets and DST transitions without a
 * dependency on Temporal or a server-side timezone library. */
export function attendanceMidnightUtc(dateKey, timeZone = ATTENDANCE_TIME_ZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey)) || !validAttendanceTimeZone(timeZone)) return NaN;
  const zone = timeZone;
  const wantedWall = Date.parse(`${dateKey}T00:00:00Z`);
  let guess = wantedWall;
  for (let i = 0; i < 5; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (name) => parts.find((part) => part.type === name)?.value || "0";
    const actualWall = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(get("hour")), Number(get("minute")), Number(get("second")));
    guess -= actualWall - wantedWall;
  }
  return guess;
}

export function splitAttendanceInterval(start, end, timeZone = ATTENDANCE_TIME_ZONE) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  if (to === from) {
    const date = attendanceDateKey(from, timeZone);
    return date ? [{ date, from: new Date(from).toISOString(), to: new Date(to).toISOString() }] : [];
  }
  const segments = [];
  let cursor = from;
  while (cursor < to) {
    const date = attendanceDateKey(cursor, timeZone);
    const nextDate = addCalendarDay(date);
    const nextMidnight = attendanceMidnightUtc(nextDate, timeZone);
    const segmentEnd = Math.min(to, Number.isFinite(nextMidnight) && nextMidnight > cursor ? nextMidnight : to);
    segments.push({ date, from: new Date(cursor).toISOString(), to: new Date(segmentEnd).toISOString() });
    if (segmentEnd >= to) break;
    cursor = segmentEnd;
  }
  return segments;
}
