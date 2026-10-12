import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");

test("embedded clock hands off to the parent before stale local state can refuse a click", () => {
  assert.match(engine, /function installParentFirstClock\(\)/);
  assert.match(engine, /parent\.__larsaPunch\(type, intent, pending\)/);
  assert.match(engine, /window\.clockToggle = wrapped/);
  assert.match(engine, /wrapped\.__larsaParentFirst = true/);
});
