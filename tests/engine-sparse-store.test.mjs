/* Larsa Control — the Timeclock engine must survive a sparse or empty store.
 *
 * The screenshot that started this: the Performance Dashboard blank, with
 *   Uncaught TypeError: Cannot read properties of undefined (reading 'forEach')
 *   (…/engines/timeclock.html)
 * thrown by v10Ensure(), which walked `state.logs` and `state.approvals`
 * without checking they existed. Two ways to get there, both real on
 * 2026-09-07:
 *
 *   1. The shared document itself had lost `approvals`, so EVERY device's
 *      state lacked it and every render died — for the whole company.
 *   2. A device whose local store had been emptied to `{}`: readStore()
 *      accepted the bare object as a store, load() adopted it, hydrate()
 *      never re-read (no __unhydrated flag), and the engine stayed dead
 *      until a full reload.
 *
 * The contract now: v10Ensure() normalises every collection it walks, and
 * readStore() only accepts an object that has a people list — anything else
 * is "nothing readable yet", so the engine boots on the unhydrated empty
 * state and hydrate() keeps re-reading until the sync layer restores the
 * real store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const line = html.split("\n")[182];
const app = JSON.parse(line.slice(line.indexOf('"'), line.lastIndexOf('"') + 1));

test("v10Ensure normalises logs and approvals before walking them", () => {
  const fn = app.slice(app.indexOf("function v10Ensure(){"), app.indexOf("function v10History("));
  assert.ok(fn.length > 200, "v10Ensure could not be isolated");
  assert.match(fn, /state\.logs = Array\.isArray\(state\.logs\) \? state\.logs : \[\];/);
  assert.match(fn, /state\.approvals = Array\.isArray\(state\.approvals\) \? state\.approvals : \[\];/);
  // Normalisation precedes the walks.
  assert.ok(fn.indexOf("state.logs = Array.isArray") < fn.indexOf("state.logs.forEach"));
  assert.ok(fn.indexOf("state.approvals = Array.isArray") < fn.indexOf("state.approvals.forEach"));
});

test("readStore refuses an object with no people list", () => {
  const fn = app.slice(app.indexOf("function readStore(){"), app.indexOf("function load(){"));
  assert.match(fn, /&&Array\.isArray\(parsed\.users\)\)\?parsed:null/);
});

test("v10Ensure runs on a bare {} state without throwing", () => {
  /* Execute the real function body against a minimal stand-in for the
     engine's globals: a `{}` state (the wiped-store case) and no-op helpers. */
  const fn = app.slice(app.indexOf("function v10Ensure(){"), app.indexOf("function v10History("));
  const run = new Function("state", "V10_SECTIONS", "save", "v10NowIso", fn + "; v10Ensure(); return state;");
  const state = run({}, [["summary", "Summary"]], () => {}, () => "2026-09-07T00:00:00Z");
  assert.deepEqual(state.logs, []);
  assert.deepEqual(state.approvals, []);
  assert.deepEqual(state.history, []);
});

test("v10Ensure runs on a real store that merely lacks approvals", () => {
  const fn = app.slice(app.indexOf("function v10Ensure(){"), app.indexOf("function v10History("));
  const run = new Function("state", "V10_SECTIONS", "save", "v10NowIso", fn + "; v10Ensure(); return state;");
  const state = run(
    { users: [{ id: "u1" }], logs: [{ id: "l1", uid: "u1", status: "In", type: "Office", time: "2026-09-07T08:00:00Z" }] },
    [["summary", "Summary"]], () => {}, () => "2026-09-07T00:00:00Z",
  );
  assert.deepEqual(state.approvals, []);
  assert.equal(state.history.length, 1, "the clock log was seeded into history");
});
