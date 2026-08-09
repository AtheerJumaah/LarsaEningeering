import test from "node:test";
import assert from "node:assert/strict";
import { pairPunchSessions, findPunchSession, planTrim } from "../lib/attendance.mjs";

/* Trim Hours correctness, exercised with real log fixtures — the exact
 * scenarios the owner's correction spec calls out. The regex tests in
 * self-trim.test.mjs prove the handlers ask these questions; this file
 * proves the answers are right.
 *
 * The fixture layouts mirror production shapes: closed pairs, several
 * sessions in one day, an open live shift, and the dangerous one — an
 * abandoned clock-in (never clocked out) followed by later real sessions,
 * which is where "the first Out after this In" used to hand back the WRONG
 * clock-out and could flip somebody's live status.
 */

const log = (id, uid, status, time, extra = {}) => ({ id, uid, status, time, ...extra });

/* Mahmoud: forgot to clock out on Monday, worked Tuesday normally, and is
 * clocked in right now (Wednesday). Three sessions: unclosed, closed, open. */
const MAHMOUD = [
  log("m1", "u1", "In", "2026-08-03T09:00:00.000Z"),
  log("m2", "u1", "In", "2026-08-04T09:00:00.000Z"),
  log("m3", "u1", "Out", "2026-08-04T17:00:00.000Z"),
  log("m4", "u1", "In", "2026-08-05T08:00:00.000Z", { active: true }),
];
const NOW = new Date("2026-08-05T12:00:00.000Z").getTime();

test("pairing mirrors the session builder: unclosed, closed, and open sessions with their boundaries", () => {
  const sessions = pairPunchSessions(MAHMOUD, "u1");
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map((s) => s.kind), ["unclosed", "closed", "open"]);
  assert.equal(sessions[0].inLog.id, "m1");
  assert.equal(sessions[0].outLog, null);
  // The abandoned Monday session is bounded by Tuesday's clock-in…
  assert.equal(sessions[0].nextTime, new Date("2026-08-04T09:00:00.000Z").getTime());
  // …Tuesday pairs with ITS OWN clock-out…
  assert.equal(sessions[1].inLog.id, "m2");
  assert.equal(sessions[1].outLog.id, "m3");
  // …and the live Wednesday shift is open with no out at all.
  assert.equal(sessions[2].inLog.id, "m4");
  assert.equal(sessions[2].outLog, null);
  assert.equal(sessions[2].nextTime, null);
});

test("a second In within 12 hours is a double-press and never starts a phantom session", () => {
  const sessions = pairPunchSessions([
    log("d1", "u2", "In", "2026-08-04T09:00:00.000Z"),
    log("d2", "u2", "In", "2026-08-04T09:00:04.000Z"),
    log("d3", "u2", "Out", "2026-08-04T17:00:00.000Z"),
  ], "u2");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].inLog.id, "d1"); // the first press is the punch
  assert.equal(sessions[0].outLog.id, "d3");
});

test("a stray Out pairs with nothing, and other people's logs never leak into the walk", () => {
  const sessions = pairPunchSessions([
    log("s1", "u3", "Out", "2026-08-04T07:00:00.000Z"),
    log("s2", "u3", "In", "2026-08-04T09:00:00.000Z"),
    log("x1", "other", "Out", "2026-08-04T10:00:00.000Z"),
    log("s3", "u3", "Out", "2026-08-04T11:00:00.000Z"),
  ], "u3");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].inLog.id, "s2");
  assert.equal(sessions[0].outLog.id, "s3");
});

test("spec scenario — trimming Monday's abandoned session closes MONDAY, and Tuesday's clock-out is untouchable", () => {
  const plan = planTrim(MAHMOUD, "u1", "2026-08-03T09:00:00.000Z", "2026-08-03T17:00:00.000Z", NOW);
  assert.equal(plan.ok, true);
  // The old code answered "move m3 earlier" here — Tuesday's clock-out,
  // a record nobody selected, which reopened Tuesday and could flip the
  // person's live status. The plan must be: close Monday's own session.
  assert.equal(plan.mode, "close");
  assert.equal(plan.session.inLog.id, "m1");
  assert.equal(plan.session.outLog, null);
});

test("spec scenario — closing an abandoned session may never reach the next clock-in", () => {
  const plan = planTrim(MAHMOUD, "u1", "2026-08-03T09:00:00.000Z", "2026-08-04T09:30:00.000Z", NOW);
  assert.deepEqual(plan, { ok: false, reason: "overlaps-next" });
});

test("spec scenario — the person clocked in RIGHT NOW keeps their open session when any older one is trimmed", () => {
  // Whatever historical session is being corrected, the live shift's own
  // records (m4) are never part of the plan.
  ["2026-08-03T09:00:00.000Z", "2026-08-04T09:00:00.000Z"].forEach((clockIn) => {
    const plan = planTrim(MAHMOUD, "u1", clockIn, "2026-08-03T10:00:00.000Z", NOW);
    if (plan.ok) {
      assert.notEqual(plan.session.inLog.id, "m4");
      assert.notEqual(plan.session.outLog?.id, "m4");
    }
  });
  // And the open session itself is only reachable by selecting IT.
  const own = planTrim(MAHMOUD, "u1", "2026-08-05T08:00:00.000Z", "2026-08-05T11:00:00.000Z", NOW);
  assert.equal(own.ok, true);
  assert.equal(own.mode, "close");
  assert.equal(own.session.inLog.id, "m4");
});

test("spec scenario — several sessions in one day: the plan lands on exactly the chosen one", () => {
  const day = [
    log("a1", "u4", "In", "2026-08-04T06:00:00.000Z"),
    log("a2", "u4", "Out", "2026-08-04T09:30:00.000Z"),
    log("a3", "u4", "In", "2026-08-04T10:00:00.000Z"),
    log("a4", "u4", "Out", "2026-08-04T13:30:00.000Z"),
    log("a5", "u4", "In", "2026-08-04T14:00:00.000Z"),
    log("a6", "u4", "Out", "2026-08-04T18:00:00.000Z"),
  ];
  const middle = planTrim(day, "u4", "2026-08-04T10:00:00.000Z", "2026-08-04T13:00:00.000Z", NOW);
  assert.equal(middle.ok, true);
  assert.equal(middle.mode, "move");
  assert.equal(middle.session.outLog.id, "a4"); // its own out — not a5's, not a1's
  const first = planTrim(day, "u4", "2026-08-04T06:00:00.000Z", "2026-08-04T09:00:00.000Z", NOW);
  assert.equal(first.ok, true);
  assert.equal(first.session.outLog.id, "a2");
});

test("the one-way rule: a clock-out moves earlier, never later, and never past now or before the clock-in", () => {
  const later = planTrim(MAHMOUD, "u1", "2026-08-04T09:00:00.000Z", "2026-08-04T18:00:00.000Z", NOW);
  assert.deepEqual(later, { ok: false, reason: "later-than-out" });
  const future = planTrim(MAHMOUD, "u1", "2026-08-05T08:00:00.000Z", "2026-08-05T13:00:00.000Z", NOW);
  assert.deepEqual(future, { ok: false, reason: "future" });
  const backwards = planTrim(MAHMOUD, "u1", "2026-08-04T09:00:00.000Z", "2026-08-04T08:00:00.000Z", NOW);
  assert.deepEqual(backwards, { ok: false, reason: "not-after-in" });
  const nonsense = planTrim(MAHMOUD, "u1", "2026-08-04T09:00:00.000Z", "not a time", NOW);
  assert.deepEqual(nonsense, { ok: false, reason: "invalid-time" });
  const missing = planTrim(MAHMOUD, "u1", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", NOW);
  assert.deepEqual(missing, { ok: false, reason: "not-found" });
});

test("a valid trim of a closed session is an in-place move of that session's own record — nothing added, nothing dropped", () => {
  const logs = MAHMOUD.map((row) => ({ ...row }));
  const plan = planTrim(logs, "u1", "2026-08-04T09:00:00.000Z", "2026-08-04T16:00:00.000Z", NOW);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "move");
  // The returned record IS the store's own object, so the handler's
  // in-place correction keeps the id and duplicates nothing.
  assert.equal(plan.session.outLog, logs[2]);
  plan.session.outLog.time = "2026-08-04T16:00:00.000Z";
  assert.equal(logs.length, 4);
  const after = pairPunchSessions(logs, "u1");
  assert.equal(after.length, 3);
  assert.equal(after[1].outLog.time, "2026-08-04T16:00:00.000Z");
  // Final duration = corrected out − in: seven hours, exactly.
  assert.equal(new Date(after[1].outLog.time) - new Date(after[1].inLog.time), 7 * 3600000);
  // Neighbours untouched, statuses preserved: Monday still unclosed,
  // Wednesday still the live open shift.
  assert.equal(after[0].kind, "unclosed");
  assert.equal(after[2].kind, "open");
  assert.equal(after[2].inLog.id, "m4");
});

test("session identity survives a re-serialised clock-in stamp", () => {
  // The UI hands back the exact stored string, but a stamp that lost its
  // milliseconds elsewhere must still find the same session, not a miss.
  const found = findPunchSession(MAHMOUD, "u1", "2026-08-04T09:00:00Z");
  assert.ok(found);
  assert.equal(found.inLog.id, "m2");
});
