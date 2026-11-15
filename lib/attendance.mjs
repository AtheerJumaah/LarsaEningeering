/* The one session-pairing engine for attendance corrections (plain .mjs so
 * the Node test suite imports the very same file the app bundles — no mirror
 * copy to drift; the same arrangement lib/duration.mjs has).
 *
 * Why this exists. A "session" is not a database row: it is DERIVED from the
 * person's ordered In/Out punch logs, by the walk buildClockSessions makes in
 * app/page.tsx. Trim, reset and the Corrections screen all need to find the
 * ONE pair of logs a session is made of — and they used to answer that with
 * "the first Out after this In", which is a different question. For a person
 * whose logs read
 *
 *     In Mon 09:00   (forgot to clock out)
 *     In Tue 09:00
 *     Out Tue 17:00
 *
 * the first Out after Monday's In is TUESDAY'S clock-out. Trimming Monday's
 * abandoned session used to move Tuesday's Out backwards a day, which closed
 * the wrong session, reopened Tuesday's, and could flip the person's live
 * clocked-in/out status. This module walks the logs with the SAME rules the
 * session builder uses, so a correction lands on exactly the records the
 * screen showed — never a neighbour's, never the active shift's.
 *
 * The rules mirrored from buildClockSessions, deliberately verbatim:
 *   - Only "In"/"Out" logs with a uid and a time take part, ordered by time.
 *   - A second In within 12 h of an open one is a double-press: ignored, the
 *     first press stays the punch.
 *   - An In 12 h or more after an open one abandons the open session — it is
 *     flagged "unclosed" (shown, never counted) and the new In starts fresh.
 *   - An Out with no open In is stray and pairs with nothing.
 *   - A final In with no later Out is the open (possibly stale) session.
 */

const DOUBLE_PRESS_GAP_HOURS = 12;

function timeOf(log) {
  return log?.time ? new Date(log.time).getTime() : NaN;
}

/** One person's In/Out punches, in the exact order the session builder
 *  reads them. Elements are the caller's own log objects, not copies, so a
 *  caller holding the store may correct a found log in place. */
export function orderedPunches(logs, uid) {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => log?.uid === uid && Number.isFinite(timeOf(log))
      && (log.status === "In" || log.status === "Out"))
    .sort((left, right) => timeOf(left) - timeOf(right)
      || Number(left.status === "In") - Number(right.status === "In"));
}

/**
 * Pair one person's punches into the sessions the app displays.
 *
 * Returns [{ inLog, outLog, kind, prevTime, nextTime }] where
 *   inLog    - the clock-in log (always present; the session's identity)
 *   outLog   - the matching clock-out log, or null for "open"/"unclosed"
 *   kind     - "closed" | "open" (live tail) | "unclosed" (abandoned)
 *   prevTime - ms of the previous session's last punch, or null: a corrected
 *              clock-in may never be dragged before this boundary
 *   nextTime - ms of the NEXT session's clock-in, or null: a corrected or
 *              newly-inserted clock-out may never reach this boundary
 */
export function pairPunchSessions(logs, uid) {
  const rows = orderedPunches(logs, uid);
  const sessions = [];
  let open = null;
  rows.forEach((row) => {
    if (row.status === "In") {
      if (open) {
        const gapHours = (timeOf(row) - timeOf(open)) / 3600000;
        if (gapHours < DOUBLE_PRESS_GAP_HOURS) return; // double-press: ignored
        sessions.push({ inLog: open, outLog: null, kind: "unclosed" });
      }
      open = row;
      return;
    }
    if (!open) return; // stray Out: pairs with nothing
    sessions.push({ inLog: open, outLog: row, kind: "closed" });
    open = null;
  });
  if (open) sessions.push({ inLog: open, outLog: null, kind: "open" });
  sessions.forEach((session, index) => {
    const previous = sessions[index - 1] || null;
    const next = sessions[index + 1] || null;
    session.prevTime = previous ? timeOf(previous.outLog || previous.inLog) : null;
    session.nextTime = next ? timeOf(next.inLog) : null;
  });
  return sessions;
}

/** Check the proposed pair and every other session before editing any logs. */
export function preservesPunchPairing(logs, uid, previous, proposed, sessions = pairPunchSessions(logs, uid)) {
  const updated = (Array.isArray(logs) ? logs : []).map((log) => {
    if (previous && log === previous.inLog) return proposed.inLog;
    if (previous?.outLog && log === previous.outLog) return proposed.outLog;
    return log;
  });
  if (!previous) updated.push(proposed.inLog);
  if (proposed.outLog && !previous?.outLog) updated.push(proposed.outLog);
  const paired = pairPunchSessions(updated, uid);
  if (paired.length !== sessions.length + (previous ? 0 : 1)) return false;
  const byClockIn = new Map(paired.map((session) => [session.inLog, session]));
  if (byClockIn.get(proposed.inLog)?.outLog !== proposed.outLog) return false;
  return sessions.every((session) => {
    if (session.inLog === previous?.inLog) return true;
    const match = byClockIn.get(session.inLog);
    return match?.outLog === session.outLog && match.kind === session.kind;
  });
}

/** Merge independent correction ranges with the live breaks of accepted
 *  shifts. A duplicate In does not end a live break. */
export function attendanceBreakSpans(logs, sessions) {
  const boundaries = new Set();
  for (const session of sessions) {
    boundaries.add(session.inLog);
    if (session.outLog) boundaries.add(session.outLog);
  }
  const order = { "Break End": 0, Out: 1, In: 2, "Break Start": 3 };
  const events = logs.filter((log) => Object.hasOwn(order, log?.status) && Number.isFinite(timeOf(log)))
    .sort((left, right) => timeOf(left) - timeOf(right) || order[left.status] - order[right.status]);
  const spans = [];
  const corrections = new Map();
  let liveStart = null;
  for (const event of events) {
    const instant = timeOf(event);
    const starts = event.status === "Break Start";
    const ends = event.status === "Break End";
    if ((starts || ends) && event.correctionId) {
      const pair = corrections.get(event.correctionId) || {};
      if (starts) pair.start ??= instant;
      if (ends) pair.end = instant;
      corrections.set(event.correctionId, pair);
    } else if (starts) {
      liveStart ??= instant;
    } else if (liveStart !== null && (ends || boundaries.has(event))) {
      spans.push({ start: liveStart, end: instant });
      liveStart = null;
    }
  }
  if (liveStart !== null) spans.push({ start: liveStart, end: Infinity });
  for (const { start, end } of corrections.values()) {
    if (end > start) spans.push({ start, end });
  }
  const merged = [];
  for (const span of spans.sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

/** The one session identified by its clock-in stamp (the identity the session
 *  builder hands the UI). Matched by exact string first, then by instant, so
 *  a stamp that was re-serialised elsewhere still finds its session. */
export function findPunchSession(logs, uid, clockIn) {
  if (!clockIn) return null;
  const sessions = pairPunchSessions(logs, uid);
  const wanted = new Date(clockIn || 0).getTime();
  return sessions.find((session) => session.inLog.time === clockIn)
    || sessions.find((session) => timeOf(session.inLog) === wanted)
    || null;
}

/**
 * Decide what a Trim does, before anything is written. Pure: no store, no
 * permissions (the caller gates those), no clock of its own — `nowMs` is the
 * server-corrected now the caller already uses for punches.
 *
 * Returns { ok: false, reason } or { ok: true, mode, session } where
 *   mode "move"  - session has its own clock-out; move it EARLIER, in place
 *   mode "close" - open or abandoned session; append its missing clock-out
 * and reason is one of
 *   "not-found"      - no session of this person starts at that stamp
 *   "invalid-time"   - the new clock-out does not parse
 *   "not-after-in"   - new clock-out at or before the clock-in
 *   "future"         - new clock-out past the (server) now
 *   "later-than-out" - trim may only move a clock-out earlier, never later
 *   "overlaps-next"  - closing would reach into the person's next session
 *   "changes-pairing" - another punch would be paired differently
 */
export function planTrim(logs, uid, clockIn, newClockOut, nowMs) {
  const session = findPunchSession(logs, uid, clockIn);
  if (!session) return { ok: false, reason: "not-found" };
  const nextOut = new Date(newClockOut || 0).getTime();
  if (!newClockOut || !Number.isFinite(nextOut)) return { ok: false, reason: "invalid-time" };
  if (nextOut <= timeOf(session.inLog)) return { ok: false, reason: "not-after-in" };
  if (Number.isFinite(nowMs) && nextOut > nowMs) return { ok: false, reason: "future" };
  if (session.outLog) {
    if (timeOf(session.outLog) < nextOut) return { ok: false, reason: "later-than-out" };
    if (timeOf(session.outLog) === nextOut) return { ok: true, mode: "move", session };
  }
  if (!session.outLog && session.nextTime !== null && nextOut >= session.nextTime) {
    return { ok: false, reason: "overlaps-next" };
  }
  const proposed = {
    inLog: session.inLog,
    outLog: { uid, status: "Out", time: newClockOut },
  };
  if (!preservesPunchPairing(logs, uid, session, proposed)) return { ok: false, reason: "changes-pairing" };
  return { ok: true, mode: session.outLog ? "move" : "close", session };
}

/** Closed shifts this long are held for a human review before they enter totals. */
export const SUSPICIOUS_CLOSED_SESSION_HOURS = 16;
/** Prompt after a completed shift; the warning does not change the punch time. */
export const LONG_HOURS_CONFIRMATION_HOURS = 10;

export function needsLongHoursConfirmation(start, end) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(to)
    && to > from + LONG_HOURS_CONFIRMATION_HOURS * 60 * 60 * 1000;
}

/* An open punch beyond a normal working day is held for correction instead
 * of continuing to accrue indefinitely. It is never auto-closed: the raw
 * In event remains intact and a person or manager must correct it. */
export const OPEN_SESSION_STALE_HOURS = 16;

export function isSuspiciousClosedSession(start, end) {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(to)
    && to >= from
    && (to - from) >= SUSPICIOUS_CLOSED_SESSION_HOURS * 60 * 60 * 1000;
}

/** Stale or abandoned open punches must never mean present now. */
export function isActiveClockSession(session) {
  return Boolean(session && session.open && !session.stale && !session.unclosed);
}
