/* Larsa Control — two defects the production-grade audit actually found by
 * driving the app, not by reading it.
 *
 * Both were silent. Neither raised a toast, neither showed in a demo click-
 * through, and neither would have been caught by staring at the screen —
 * one needed a rapid double-click, the other needed a browser that already
 * had a stale copy of the timeclock engine cached from before "schedule"
 * existed on its stored state. The fixes are the smallest ones that close
 * each gap; these tests exist so neither regresses silently the way it
 * arrived silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const page = await readFile(new URL("app/page.tsx", root), "utf8");

// ------------------------------------------------------- 1. Add My Points
// A rapid double-click fired saveMyPoints twice before React could disable
// the button, and each call built its own fresh id (Date.now()+Math.random())
// — so both writes landed as two separate performance rows for one submission.
// punchClock already solved this exact problem for the clock; the fix here is
// the same 1.2s window, held on the way in rather than read back out of
// storage, because a performance row carries no save timestamp to compare.

test("saveMyPoints holds the same double-tap window punchClock uses", () => {
  assert.match(page, /const lastPointsSaveRef = useRef\(0\);/);
  const fn = page.match(/const saveMyPoints = \(draft: PerformanceDraft, submit: boolean\) => \{[\s\S]*?\n  \};/);
  assert.ok(fn, "saveMyPoints could not be found");
  assert.match(fn[0], /const saveNow = Date\.now\(\);/);
  assert.match(fn[0], /if \(saveNow - lastPointsSaveRef\.current < 1200\) return false;/);
  assert.match(fn[0], /lastPointsSaveRef\.current = saveNow;/);
});

test("the guard sits before any write, so both the normal save and the closed-week request path are covered", () => {
  const fn = page.match(/const saveMyPoints = \(draft: PerformanceDraft, submit: boolean\) => \{[\s\S]*?\n  \};/)[0];
  const guardAt = fn.indexOf("lastPointsSaveRef.current = saveNow;");
  const lockWriteAt = fn.indexOf("store.approvals.unshift(record);");
  const draftWriteAt = fn.indexOf("state.performance.unshift(row);");
  assert.ok(guardAt > 0 && guardAt < lockWriteAt && guardAt < draftWriteAt,
    "the guard must run before either place that writes a row");
});

test("a suppressed repeat stays quiet rather than saying it failed", () => {
  // Mirrors punchClock: the first click's toast is still on screen, so the
  // second click returning false with no notify() is feedback, not silence.
  const fn = page.match(/const saveMyPoints = \(draft: PerformanceDraft, submit: boolean\) => \{[\s\S]*?\n  \};/)[0];
  const guardLine = fn.match(/if \(saveNow - lastPointsSaveRef\.current < 1200\) return false;/)[0];
  assert.doesNotMatch(guardLine, /notify/);
});

// ------------------------------------------------- 2. the timeclock engine
// ensureV21() reads state.schedule with optional chaining but wrote to it
// unguarded: state.schedule?.[u.id] can be falsy either because schedule
// itself is missing or because just that user's entry is missing, but only
// the second case is safe to write with state.schedule[u.id] = {}. On any
// stored state old enough to predate the "schedule" bucket entirely, the
// write threw — on every single page load, before a user even signed in,
// because ensureV21() runs during the engine's own bootstrap.

async function decodedEngine() {
  const raw = await readFile(new URL("public/engines/timeclock.html", root), "utf8");
  const wrapped = raw.match(/<script type="__bundler\/template">\n([\s\S]*?)\n {2}<\/script>/);
  assert.ok(wrapped, "the bundled template script could not be found");
  return JSON.parse(wrapped[1]);
}

test("ensureV21 guarantees state.schedule is an object before indexing into it per user", async () => {
  const engine = await decodedEngine();
  const fn = engine.match(/function ensureV21\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, "ensureV21 could not be found in the decoded engine");
  const body = fn[0];
  const guardAt = body.indexOf("state.schedule=state.schedule||{};");
  const loopAt = body.indexOf("enabledUsers().forEach");
  assert.ok(guardAt > 0, "state.schedule is never defaulted to an object");
  assert.ok(guardAt < loopAt, "the guard must run before the per-user loop that indexes into it");
});

test("running the fixed lines against the exact state that used to crash them does not throw", async () => {
  /* The read (state.schedule?.[u.id]) was always safe; the write two
     characters later (state.schedule[u.id] = {}) was not, whenever
     state.schedule itself — not just this user's entry — was missing. That
     is the precise, minimal shape of stored state that used to crash on
     every load: a user with no "schedule" key on state at all. Extracting
     the real fixed lines and running them against that shape is a stronger
     regression check than pattern-matching the source, because it fails
     the same way the original bug did if the guard is ever lost. */
  const engine = await decodedEngine();
  const fn = engine.match(/function ensureV21\(\)\{[\s\S]*?\n\}/)[0];
  const guardLine = fn.match(/state\.scheduleTargets=state\.scheduleTargets\|\|\{\};\n {2}state\.schedule=state\.schedule\|\|\{\};/);
  const perUserLine = fn.match(/if\(!state\.schedule\?\.\[u\.id\]\)\{state\.schedule\[u\.id\]=\{\};DAYS_OFFICE\.forEach\(d=>state\.schedule\[u\.id\]\[d\]=\[\]\)\}/);
  assert.ok(guardLine, "the state.schedule||{} guard line could not be found");
  assert.ok(perUserLine, "the per-user schedule initialisation could not be found");

  const DAYS_OFFICE = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const run = (source, state, u) => new Function("state", "u", "DAYS_OFFICE", `${source}\nreturn state;`)(state, u, DAYS_OFFICE);

  // The exact shape that used to crash: a user, and no "schedule" key at all.
  const before = { scheduleTargets: {} };
  assert.throws(() => run(perUserLine[0], before, { id: "u1" }), TypeError,
    "the write alone should still throw without the guard — confirms the test reproduces the original crash");

  // The shipped fix: the guard line runs first, exactly as it does in ensureV21.
  const after = { scheduleTargets: {} };
  assert.doesNotThrow(() => {
    run(guardLine[0], after, { id: "u1" });
    run(perUserLine[0], after, { id: "u1" });
  });
  assert.deepEqual(after.schedule.u1, { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] });
});

// ---------------------------------------------------- 3. shipping the fix
// A corrected engine file means nothing if the service worker keeps handing
// out the cached copy from before the fix. The cache name is the eviction
// switch (see public/sw.js's own comment on this exact failure mode) —
// bumping it is part of the fix, not a separate step.

test("the service worker cache version was bumped to actually ship the engine fix", async () => {
  const sw = await readFile(new URL("public/sw.js", root), "utf8");
  const match = sw.match(/const CACHE_NAME = "larsa-control-v(\d+)";/);
  assert.ok(match, "cache name pattern not found");
  assert.ok(Number(match[1]) >= 28, `expected v28 or later, found v${match[1]}`);
});
