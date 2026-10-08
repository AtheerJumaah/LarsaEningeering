/* The intent shown by the button is sent to the serialized attendance ledger. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const raw = await read("public/engines/timeclock.html");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);
const punch = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));

test("the app sends the button intent as the atomic event status", () => {
  assert.match(punch, /const decided: "In" \| "Out" = intent \?\? \(currentLog\?\.status === "In" \? "Out" : "In"\);/);
  assert.match(punch, /status: decided,/);
  assert.match(punch, /await recordAttendancePunch\(event\)/);
  assert.doesNotMatch(punch, /if \(trueStatus !== null && trueStatus === decided/);
});

test("the clock button hands over the action it displayed", () => {
  assert.match(page, /punch\(open \? open\.mode : mode, note, open \? "Out" : "In"\)/);
  assert.match(page, /punch: \(mode: string, note\?: string, intent\?: "In" \| "Out"\) => Promise<boolean>;/);
});

test("the embedded engine hands clock actions to the app's one writer", () => {
  assert.match(engine, /function larsaAppPunch\(\)\{try\{var p=window\.parent;if\(p&&p!==window&&typeof p\.__larsaPunch==='function'\)return p\.__larsaPunch\}catch\(e\)\{\}return null\}/);
  assert.match(engine, /var hand=larsaAppPunch\(\);if\(hand\)\{var pending=window\.__larsaPendingNote\|\|'';window\.__larsaPendingNote='';try\{hand\(type,status,pending,currentUser\.id\);return\}/);
  assert.match(page, /holder\.__larsaPunch = \(mode, intent, note, uid\) => \{/);
  assert.match(page, /void punchClockGuarded\(mode, note \|\| "", intent\);/);
});
