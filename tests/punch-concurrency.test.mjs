/* Larsa Control — two presses can never become one lost punch, and a punch can
 * never land on the wrong person.
 *
 * Both hazards were introduced BY earlier clock fixes, which is the point of
 * writing them down.
 *
 *   1. LOST PUNCH. Making the punch path ask the server first turned a
 *      synchronous read-modify-write into an asynchronous one: an `await` sits
 *      between reading the staff document and writing it back. Two presses
 *      landing together — the panel and the app, or two fast taps on the
 *      engine button, which carries no in-flight state of its own — could each
 *      parse a copy lacking the other's punch, and the later write would
 *      silently drop the earlier one. The press-again flow makes this MORE
 *      reachable, not less: it invites exactly the quick second press. An
 *      audit of all writers of the staff document showed the hazard is unique
 *      to the two that await; every other writer is synchronous and so atomic.
 *
 *   2. WRONG PERSON. The engine keeps its own `currentUser`, seeded by the app
 *      at sign-in; the app punches for `sessionUserRef.current`. The hand-off
 *      ASSUMED those agree. They do in practice — but a punch landing on
 *      somebody else's timesheet is not a risk worth carrying on an
 *      assumption.
 *
 *   3. STALE REBUILD. `autoBuildWeek` read the whole document, then asked a
 *      confirm question that can sit open for minutes, then wrote its copy
 *      back — discarding anything that arrived while the person decided.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const raw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);

test("only one punch at a time may be inside the read-modify-write", () => {
  assert.match(page, /const punchLock = useRef\(false\);/);
  // The lock wraps BOTH writers, and both share it.
  assert.match(page, /const punchClockGuarded = useCallback\(async \(mode: string, note = "", intent\?: AttendancePunchInput\["status"\], quiet = false, targetUid\?: string\) => \{\s*\n\s*if \(punchLock\.current\)/);
  assert.match(page, /const punchBreakGuarded = useCallback\(async \(note = "", intent\?: "Break Start" \| "Break End"\) => \{\s*\n\s*if \(punchLock\.current\)/);
  // Released on every path, including the ones that throw.
  const releases = page.match(/finally \{ punchLock\.current = false; \}/g) || [];
  assert.equal(releases.length, 2, "both wrappers must release the lock in a finally");
  // The writers keep their names; the lock is a separate, guarded entry point.
  assert.match(page, /return await punchClock\(mode, note, intent, quiet, targetUid\);/);
  assert.match(page, /return await punchBreak\(note, intent\);/);
});

test("every caller goes through the lock, none straight to the writer", () => {
  /* The engine button has no React state of its own, so a guard living on the
     app's button would not protect the hand-off path at all. The only things
     allowed to call the raw writers are the two lock wrappers. */
  assert.match(page, /void punchClockGuarded\(mode, note \|\| "", intent\);/);
  assert.match(page, /void punchBreakGuarded\(note \|\| "", intent\);/);
  assert.match(page, /punch=\{punchClockGuarded\}/);
  assert.match(page, /punchBreak=\{punchBreakGuarded\}/);
  assert.doesNotMatch(page, /void punchClock\(/, "nothing may call the unlocked clock writer directly");
  assert.doesNotMatch(page, /void punchBreak\(/, "nothing may call the unlocked break writer directly");
  assert.match(page, /if \(await punchBreakGuarded\(note, "Break End"\)\)/);
  assert.match(page, /if \(await punchBreakGuarded\(note, "Break Start"\)\)/);
});

test("a punch is refused if the panel is showing a different person", () => {
  // The panel signs the hand-off with the user IT believes is clocking.
  assert.match(raw, /parent\.__larsaPunch\(type, intent, pending, typeof currentUser !== 'undefined' && currentUser \? currentUser\.id : undefined\)/);
  assert.match(engine, /p\.__larsaBreak\(offering,note\|\|'',currentUser\.id\);return;/);
  // And the app checks that signature against its own session.
  assert.match(page, /__larsaPunch\?: \(mode: string, intent: "In" \| "Out", note\?: string, uid\?: string\) => void;/);
  assert.match(page, /__larsaBreak\?: \(intent: "Break Start" \| "Break End", note\?: string, uid\?: string\) => void;/);
  const checks = page.match(/if \(!uid \|\| !me \|\| String\(uid\) !== String\(me\.id\)/g) || [];
  assert.equal(checks.length, 2, "both hand-offs must verify the signature");
  assert.match(page, /This Timeclock panel is showing a different person\./);
});

test("an engine without an identity signature cannot clock", () => {
  /* Cached panels must reconnect rather than create an unattributed punch. */
  assert.match(page, /if \(!uid \|\| !me \|\| String\(uid\) !== String\(me\.id\)/);
});

test("the week rebuild reads the document after the question, not before", () => {
  const build = page.slice(page.indexOf("const autoBuildWeek = useCallback"), page.indexOf("const saveShiftColours = useCallback"));
  assert.ok(build.length > 400, "autoBuildWeek could not be isolated");
  const askAt = build.indexOf("await dialog.confirm(");
  const readAt = build.indexOf('const store = parseStore("larsaStaffV8")');
  assert.ok(askAt > 0 && readAt > 0, "both the question and the read must be present");
  assert.ok(askAt < readAt, "the confirm must come BEFORE the store is read");
});

test("an uncertain save stays queued and the same id is retried", () => {
  const guarded = page.slice(page.indexOf("const punchClockGuarded"), page.indexOf("/* The Timeclock panel's clock button"));
  assert.match(guarded, /finally \{ punchLock\.current = false; \}/);
  const writer = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));
  assert.match(writer, /writeAttendanceQueue\(queueKey, pending\)/);
  assert.match(writer, /const result = await recordAttendancePunch\(event\);/);
  const unavailableAt = writer.indexOf("if (result.outcome === \"unavailable\"");
  const confirmedConsumeAt = writer.indexOf("pending.splice", writer.indexOf("lastOutcome = result.outcome;"));
  assert.ok(unavailableAt >= 0 && confirmedConsumeAt > unavailableAt,
    "a timeout must leave the unresolved event in the queue");
});

test("a confirmed server punch cannot be turned into a repeat press by a cache write failure", () => {
  const writer = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));
  const serverConfirmed = writer.indexOf("lastOutcome = result.outcome;");
  const consumeQueue = writer.indexOf("pending.splice", serverConfirmed);
  const saveQueue = writer.indexOf('writeAttendanceQueue(queueKey, pending)', consumeQueue);
  const refreshCache = writer.indexOf('localStorage.setItem("larsaStaffV8", JSON.stringify(store))', saveQueue);
  assert.ok(serverConfirmed >= 0 && consumeQueue > serverConfirmed && saveQueue > consumeQueue,
    "remove a server-confirmed request from the pending queue first");
  assert.ok(refreshCache > saveQueue, "the local cache is updated after the queue is consumed");
  assert.match(writer.slice(saveQueue, refreshCache), /clearAttendanceQueue\(queueKey\)/,
    "storage errors must not escape the confirmed server path");
  assert.match(writer, /saved on the server, but this device could not refresh/,
    "tell the employee the server saved it if this browser cannot refresh");
});

test("an online authoritative punch is not submitted again by the compatibility ledger tap", async () => {
  const writer = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));
  assert.match(writer, /markAttendanceEventSent\(eventId\);/);
  const ledger = await readFile(new URL("../lib/ledger.ts", import.meta.url), "utf8");
  assert.match(ledger, /export function markAttendanceEventSent\(clientEventId: string\)/);
});

test("pending punches resume automatically and reuse their queued event id", () => {
  assert.match(page, /const retryPending = \(\) => \{/);
  assert.match(page, /window\.setInterval\(retryPending, 15_000\)/);
  assert.match(page, /window\.addEventListener\("online", retryPending\)/);
  assert.match(page, /window\.addEventListener\("focus", retryPending\)/);
  assert.match(page, /punchClockGuarded\(latest\.work_mode \|\| "Office", latest\.note \|\| "", latest\.status, true, uid\)/);
  assert.match(page, /no extra click is needed\./);
});
