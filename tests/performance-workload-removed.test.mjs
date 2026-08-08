import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* The Performance page no longer carries the clock-session workload block.
 *
 * It used to embed a "Timesheet" section — three session charts plus a
 * dual-timezone Employee / Mode / Mosul-Baghdad / US Central / Hours / Status
 * table — duplicating what Clock In / Out and Timesheet & Reports already
 * show, and displaying raw account ids for departed people. Removed on the
 * owner's instruction, Aug 8 2026. Performance keeps its points, charts,
 * employee cards and filters; the dedicated Timesheet page keeps the
 * session views. */

const root = new URL("..", import.meta.url);

async function loadEngineTemplate() {
  const raw = await readFile(new URL("public/engines/timeclock.html", root), "utf8");
  const match = raw.match(/<script type="__bundler\/template">\n(.*?)\n {2}<\/script>/s);
  assert.ok(match, "the engine must carry its bundler template");
  return JSON.parse(match[1]);
}

test("the workload block is stubbed out at the source, for every caller", async () => {
  const tpl = await loadEngineTemplate();
  const stubs = tpl.match(/function timesheetBlock\(\)\{\/\* Removed on the owner's instruction[^]*?return ''\}/g) || [];
  assert.equal(stubs.length, 2, "both layered definitions must be the empty stub");
  // No definition may still build the section.
  assert.ok(!/function timesheetBlock\(\)\{const view/.test(tpl), "no live table-building definition may remain");
});

test("the final Performance renderer neither embeds the block nor offers its dead timezone filter", async () => {
  const tpl = await loadEngineTemplate();
  const line = tpl.split("\n").find((row) => row.startsWith("function renderPerformanceV22b()"));
  assert.ok(line, "renderPerformanceV22b is the final Performance renderer");
  assert.ok(!line.includes("${timesheetBlock()}"), "the workload block is no longer embedded");
  assert.ok(!line.includes("Timesheet Time Zone"), "the timezone filter served only the removed table");
  // The filter grid shrank to match its three remaining fields.
  assert.ok(line.includes('class="grid cols3"'), "filter panel is a three-column grid now");
  // And it is still the renderer that wins.
  assert.match(tpl, /W\.renderPerformance=renderPerformanceV22b/);
  // What Performance is for stays: points, employees, filters.
  assert.ok(line.includes("Points by Employee"));
  assert.ok(line.includes("Add Performance Row"));
});

test("the dedicated Timesheet page keeps its session views — only Performance lost them", async () => {
  const tpl = await loadEngineTemplate();
  // The Timesheet page's own dual-timezone table remains untouched.
  assert.match(tpl, /function timesheetTable23\(/);
  assert.match(tpl, /function table26\(/);
});
