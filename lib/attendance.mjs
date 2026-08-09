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
  const ms = new Date((log && log.time) || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** One person's In/Out punches, in the exact order the session builder
 *  reads them. Elements are the caller's own log objects, not copies, so a
 *  caller holding the store may correct a found log in place. */
export function orderedPunches(logs, uid) {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => log && log.uid === uid && log.time
      && (log.status === "In" || log.status === "Out"))
    .sort((left, right) => timeOf(left) - timeOf(right));
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

/** The one session identified by its clock-in stamp (the identity the session
 *  builder hands the UI). Matched by exact string first, then by instant, so
 *  a stamp that was re-serialised elsewhere still finds its session. */
export function findPunchSession(logs, uid, clockIn) {
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
    return { ok: true, mode: "move", session };
  }
  if (session.nextTime !== null && nextOut >= session.nextTime) {
    return { ok: false, reason: "overlaps-next" };
  }
  return { ok: true, mode: "close", session };
}
