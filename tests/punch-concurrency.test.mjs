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
  assert.match(page, /const punchClockGuarded = useCallback\(async \(mode: string, note = "", intent\?: "In" \| "Out"\) => \{\s*\n\s*if \(punchLock\.current\)/);
  assert.match(page, /const punchBreakGuarded = useCallback\(async \(note = "", intent\?: "Break Start" \| "Break End"\) => \{\s*\n\s*if \(punchLock\.current\)/);
  // Released on every path, including the ones that throw.
  const releases = page.match(/finally \{ punchLock\.current = false; \}/g) || [];
  assert.equal(releases.length, 2, "both wrappers must release the lock in a finally");
  // The writers keep their names; the lock is a separate, guarded entry point.
  assert.match(page, /return await punchClock\(mode, note, intent\);/);
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
  const rawCalls = (page.match(/(?<!await )(?<!const )punchClock\(/g) || [])
    .concat(page.match(/(?<!await )(?<!const )punchBreak\(/g) || []);
  assert.equal(rawCalls.length, 0, "nothing may call the unlocked writers directly");
});

test("a punch is refused if the panel is showing a different person", () => {
  // The panel signs the hand-off with the user IT believes is clocking.
  assert.match(engine, /try\{hand\(type,status,pending,currentUser\.id\);return\}/);
  assert.match(engine, /try\{hand\(offering, note\|\|'', currentUser\.id\);return\}/);
  // And the app checks that signature against its own session.
  assert.match(page, /__larsaPunch\?: \(mode: string, intent: "In" \| "Out", note\?: string, uid\?: string\) => void;/);
  assert.match(page, /__larsaBreak\?: \(intent: "Break Start" \| "Break End", note\?: string, uid\?: string\) => void;/);
  const checks = page.match(/if \(uid && me && String\(uid\) !== String\(me\.id\)\) \{/g) || [];
  assert.equal(checks.length, 2, "both hand-offs must verify the signature");
  assert.match(page, /This Timeclock panel is showing a different person\./);
});

test("an engine still on an older build can still clock", () => {
  /* The check is `uid && …`: a panel that sends no uid is accepted. Refusing
     it would stop everyone on a cached engine from clocking at all — a worse
     outcome than the risk being closed. */
  assert.match(page, /if \(uid && me &&/);
  assert.doesNotMatch(page, /if \(!uid\) return;/);
});

test("the week rebuild reads the document after the question, not before", () => {
  const build = page.slice(page.indexOf("const autoBuildWeek = useCallback"), page.indexOf("const saveShiftColours = useCallback"));
  assert.ok(build.length > 400, "autoBuildWeek could not be isolated");
  const askAt = build.indexOf("await dialog.confirm(");
  const readAt = build.indexOf('const store = parseStore("larsaStaffV8")');
  assert.ok(askAt > 0 && readAt > 0, "both the question and the read must be present");
  assert.ok(askAt < readAt, "the confirm must come BEFORE the store is read");
});

test("the lock cannot swallow an insisting second press", () => {
  /* A refused first press releases the lock before it returns (the finally),
     so the press-again offer is made with the lock already free. The refusal
     bookkeeping lives INSIDE the locked writer, where it is race-free. */
  const guarded = page.slice(page.indexOf("const punchClockGuarded"), page.indexOf("/* The Timeclock panel's clock button"));
  assert.match(guarded, /finally \{ punchLock\.current = false; \}/);
  const writer = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));
  assert.match(writer, /clockRefusals\.current\[refusalKey\] = serverNowMs\(\);/);
});
