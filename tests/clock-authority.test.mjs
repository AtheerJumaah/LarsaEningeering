/* Larsa Control — a punch is decided by the shared record, never by one
 * device's cached copy of it.
 *
 * Three fixes preceded this one and each closed a real hole: the demo seed
 * that fabricated punches (23 Aug), the toggle that could write the opposite
 * of what the button offered (24 Aug), and the merge that read absence as
 * deletion (24 Aug). People were still being clocked in and out "by nobody",
 * and the measurement said why: of 216 punches in the five days after the
 * intent guard, **25 were corrected by the same person within 30 seconds** —
 * one in eight — overwhelmingly `Out→In` in 2–5 seconds and clustered at
 * arrival times (06:55, 07:18, 08:07). That is the shape of a first tap after
 * opening the app.
 *
 * The cause was one level above the intent guard. The app paints instantly
 * from cached local storage (837 KB store), the clock button is live at first
 * paint, and people press it immediately — pressing the clock is why they
 * opened the app. Both the label AND the write came from that cached copy,
 * which after a night, a sleep, or a switch of phone is yesterday's truth.
 * The intent guard compares the screen to that same copy, so they agree and
 * the wrong punch is written. Two cases stuck, and the per-device clock-skew
 * fingerprint proved a second device in each: Mahmood Al-Nuri (24 Aug, a
 * second `Out` ten minutes after another device clocked him out) and Farah
 * Nabeel (26 Aug 07:42:59 `Out` then 07:43:02 `In`, on a device that had
 * never seen the previous evening's `Out`).
 *
 * The rules now, in order:
 *   1. HOLD — a press before this session has heard from the server waits for
 *      it rather than acting on the cache. The press is queued, not dropped.
 *   2. CONFIRM — the newest of (shared append-only ledger, this device) is the
 *      truth; the ledger is asked for one indexed row, not the whole store.
 *   3. REFUSE — a press that contradicts the truth writes nothing at all.
 *   4. NO-OP — a punch that would not change the state is never recorded, so
 *      no duplicate can ever open or close a shift.
 *   5. ONE WRITER — the Timeclock panel hands its punch to the same guarded
 *      writer instead of appending from its own copy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ledger = await readFile(new URL("../lib/ledger.ts", import.meta.url), "utf8");
const raw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);

const punch = page.slice(
  page.indexOf("const punchClock = useCallback"),
  page.indexOf("const punchBreak = useCallback"),
);
assert.ok(punch.length > 500, "punchClock could not be isolated");

test("1. a press before the server has been heard from is HELD, not guessed", () => {
  assert.match(page, /const \[clockConfirmed, setClockConfirmed\] = useState\(false\);/);
  assert.match(page, /const whenClockConfirmed = useCallback\(\(timeoutMs = 8000\)/);
  assert.match(punch, /if \(!clockConfirmedRef\.current\) \{/);
  assert.match(punch, /await whenClockConfirmed\(\);/);
  // Released — not blocked for ever — when there is no server at all.
  assert.match(page, /if \(status === "offline"\) \{[\s\S]{0,400}?markClockConfirmed\(\);/);
  assert.match(page, /if \(status !== "synced"\) return;\s*\n\s*markClockConfirmed\(\);/);
});

test("2. the truth comes from the shared ledger, newest wins", () => {
  assert.match(ledger, /export async function confirmClockState\(\s*\n\s*uid: string,\s*\n\s*removedIds: readonly string\[\] = \[\],\s*\n\s*timeoutMs = 3500,\s*\n\)/);
  // One indexed row for one person — not the whole store.
  assert.match(ledger, /\.eq\("uid", uid\)/);
  assert.match(ledger, /\.in\("status", \["In", "Out"\]\)/);
  /* A handful of rows, not one: the newest row may be a punch a manager
     DELETED, and the answer then has to be the newest one that survives
     rather than a record that no longer exists. Still one indexed lookup. */
  assert.match(ledger, /\.order\("occurred_at", \{ ascending: false \}\)[\s\S]{0,260}?\.limit\(25\)/);
  // A punch this device queued but has not delivered yet still counts.
  assert.match(ledger, /const queued = readJson<LedgerEvent\[\]>\(QUEUE_KEY, \[\]\)/);
  // Offline says so rather than pretending silence is an answer.
  assert.match(ledger, /const unknown: ConfirmedClock = \{ reached: false, status: null, at: null \};/);
  assert.match(punch, /const confirmed = await confirmClockState\(user\.id, preStore\?\.removedLogIds \|\| \[\]\);/);
  /* Newest wins — unless the person has just been turned away for this same
     press, in which case the staff document gets the last word so nobody can
     be locked out of their own timesheet. */
  assert.match(punch, /const ledgerWins = !insisting && confirmed\.reached && Boolean\(confirmed\.status\) && serverAt >= localAt;/);
  assert.match(punch, /const trueStatus: "In" \| "Out" \| null = ledgerWins/);
});

test("3. a press that contradicts the truth writes nothing", () => {
  assert.match(punch, /if \(intent && intent !== status\) \{/);
  assert.match(punch, /nothing was changed\. This screen was out of date and has been refreshed\./);
  const refuseAt = punch.indexOf("if (intent && intent !== status)");
  assert.ok(refuseAt > 0 && refuseAt < punch.indexOf("store.logs.push("),
    "the refusal must run before anything is appended");
});

test("4. a punch that would change nothing is never recorded", () => {
  assert.match(punch, /if \(trueStatus !== null && trueStatus === status\) \{/);
  assert.match(punch, /You are already clocked in\$\{since\}\./);
  const noopAt = punch.indexOf("if (trueStatus !== null && trueStatus === status)");
  assert.ok(noopAt > 0 && noopAt < punch.indexOf("store.logs.push("),
    "the no-op guard must run before anything is appended");
});

test("5. the Timeclock panel hands its punch to the same guarded writer", () => {
  assert.match(engine, /function larsaAppPunch\(\)\{try\{var p=window\.parent;if\(p&&p!==window&&typeof p\.__larsaPunch==='function'\)return p\.__larsaPunch\}catch\(e\)\{\}return null\}/);
  // Signed with the panel's own user, so the app can refuse a punch that would
  // land on somebody else — see tests/punch-concurrency.test.mjs.
  assert.match(engine, /var hand=larsaAppPunch\(\);if\(hand\)\{var pending=window\.__larsaPendingNote\|\|'';window\.__larsaPendingNote='';try\{hand\(type,status,pending,currentUser\.id\);return\}/);
  // The note the person typed travels with the hand-off.
  assert.match(engine, /window\.__larsaPendingNote = note \|\| '';/);
  // And the app publishes exactly that hook.
  assert.match(page, /holder\.__larsaPunch = \(mode, intent, note, uid\) => \{/);
  assert.match(page, /void punchClockGuarded\(mode, note \|\| "", intent\);/);
});

test("the gate can never strand the clock", () => {
  /* The gate is released by onStatusChange. But initLarsaSync returns without
     reporting any status when Supabase is not configured, and a bootstrap that
     hangs instead of failing reports nothing either \u2014 in both cases a button
     gated on it would stay dead for ever, which is a worse bug than the one
     being fixed. Two escapes, and neither costs any safety: the guarantee is
     confirmClockState on the press, not the gate. */
  assert.match(page, /const clockGateCeiling = window\.setTimeout\(markClockConfirmed, supabaseConfigured\(\) \? 12000 : 0\);/);
  assert.match(page, /window\.clearTimeout\(clockGateCeiling\);/);
  // And a held press resolves on its own clock too, so it can never hang.
  assert.match(page, /window\.setTimeout\(\(\) => done\(clockConfirmedRef\.current\), timeoutMs\);/);
});

test("the button cannot be pressed into a guess, and says why", () => {
  assert.match(page, /disabled=\{!clockReady \|\| punching\}/);
  assert.match(page, /\{!clockReady \? "Checking your status…" : punching \? "Saving…" : open \? "Clock Out" : "Clock In"\}/);
  assert.match(page, /clockReady=\{clockConfirmed\}/);
  // Awaited, so a held press still clears the note only when it truly landed.
  assert.match(page, /if \(await punch\(open \? open\.mode : mode, note, open \? "Out" : "In"\)\) setNote\(""\);/);
});
