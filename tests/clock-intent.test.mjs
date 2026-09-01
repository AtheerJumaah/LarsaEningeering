/* Larsa Control — a clock press can never do the opposite of what it offered.
 *
 * The remaining "clocked in / clocked out without knowing" reports, after the
 * demo-seed fix, came from the same shape of defect one level down: the
 * direction of a punch was derived from whatever copy of the log the pressing
 * surface happened to hold, and then written whatever it came out as.
 *
 * There are two surfaces and they hold DIFFERENT copies. The native app reads
 * localStorage, which the sync layer keeps current. The Timeclock engine read
 * its own in-memory `state`, a snapshot from whenever that panel last
 * rendered. On 24 Aug an engineer pressed the engine's button and was clocked
 * OUT (its snapshot still held a punch his device had not yet dropped), then
 * pressed the app's button three seconds later and was clocked IN. He asked
 * for neither.
 *
 * Two rules now, on both surfaces:
 *
 *   1. Read fresh at the moment of the decision — the label the person reads
 *      and the record the app writes come from the same current facts.
 *   2. Carry the INTENT the pressed button was offering. If the truth
 *      disagrees, write NOTHING, say what the record actually holds, and
 *      redraw. A toggle turns stale data into a silent opposite punch; an
 *      intent turns it into a visible disagreement that changes nobody's
 *      status.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const raw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);

test("the app refuses to write the opposite of what the button offered", () => {
  assert.match(page, /const punchClock = useCallback\(async \(mode: string, note = "", intent\?: "In" \| "Out"\) => \{/);
  assert.match(page, /if \(intent && intent !== status\) \{/);
  assert.match(page, /nothing was changed\. This screen was out of date and has been refreshed\./);
  // And it names the state the record actually holds, with the time it began.
  assert.match(page, /`You are already clocked in\$\{since\} — nothing was changed\./);
  // Refused, and refused BEFORE anything is appended or stored.
  const body = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchBreak = useCallback"));
  const guardAt = body.indexOf("if (intent && intent !== status)");
  assert.ok(guardAt > 0 && guardAt < body.indexOf("store.logs.push("), "the guard must run before the write");
  // What follows the refusal is the second refusal (a no-op punch), and only
  // then the write — so neither disagreement can reach store.logs.
  assert.match(body, /return false;\s*\n\s*\}\s*\n\s*delete clockRefusals\.current\[refusalKey\];\s*\n\s*\/\* Belt and braces: a punch that would not CHANGE anything/);
});

test("the button hands over exactly what it displayed", () => {
  assert.match(page, /punch\(open \? open\.mode : mode, note, open \? "Out" : "In"\)/);
  assert.match(page, /punch: \(mode: string, note\?: string, intent\?: "In" \| "Out"\) => Promise<boolean>;/);
});

test("the engine decides from a fresh read, not its own old snapshot", () => {
  assert.match(engine, /function freshState\(\)\{var real=readStore\(\);if\(real&&Array\.isArray\(real\.users\)&&real\.users\.length\)\{state=real;/);
  assert.match(engine, /function lastPunchOf\(uid\)\{/);
  // Both the write and both clock screens re-read before they decide or draw.
  assert.match(engine, /function clockToggle\(type,intent\)\{freshState\(\);let latest=lastPunchOf\(currentUser\.id\);/);
  assert.match(engine, /function renderClockV22b\(\)\{if\(!currentUser\)return;freshState\(\);/);
  assert.match(engine, /freshState\(\); const type=selectedClockType\(\);/);
});

test("the engine refuses the opposite punch too, and nothing is written", () => {
  assert.match(engine, /if\(intent&&intent!==status\)\{toast\(status==='Out'\?'You are already clocked in - nothing was changed\.':'You are already clocked out - nothing was changed\.'\);/);
  assert.match(engine, /if\(typeof render==='function'\)render\(\);return\}/);
});

test("intent survives every wrapper between the button and the write", () => {
  /* clockToggle is wrapped four times over (history, v21 redraw, v30 note
     prompt). A wrapper that forgot the second argument would silently restore
     the old toggle behaviour, which is exactly the kind of quiet regression
     this file exists to catch. */
  assert.match(engine, /clockToggle\('\$\{h\(type\)\}','\$\{isIn\?'Out':'In'\}'\)/);
  assert.match(engine, /V11\.clockSelected=function\(\)\{var l=clockStatusForUser\(currentUser\.id\);window\.clockToggle\(selectedClockType\(\),\(l&&l\.status==='In'\)\?'Out':'In'\);\};/);
  assert.match(engine, /_v10ClockToggle\.apply\(this,arguments\);/);
  assert.match(engine, /window\.clockToggle = function\(type,intent\)\{/);
  assert.match(engine, /v30RealClockToggle\.call\(this, type, intent\);/);
  assert.doesNotMatch(engine, /_v10ClockToggle\(type\);/);
  assert.doesNotMatch(engine, /v30RealClockToggle\.call\(this, type\);/);
});
