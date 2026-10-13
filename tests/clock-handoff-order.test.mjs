import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");

test("embedded clock hands off to the parent before stale local state can refuse a click", () => {
  assert.match(engine, /function larsaAppPunch\(\)/);
  assert.match(engine, /var hand = larsaAppPunch\(\);/);
  assert.match(engine, /if\(hand && \(intent==='In'\|\|intent==='Out'\)\)\{/);
  assert.match(engine, /hand\(type,intent,pending,currentUser\.id\);/);
  /* The handoff must occur before the standalone panel's stale-state path. */
  assert.ok(
    engine.indexOf("var hand = larsaAppPunch();") < engine.indexOf("freshState();let latest=lastPunchOf"),
    "the parent writer must run before stale local-state checks",
  );
});
