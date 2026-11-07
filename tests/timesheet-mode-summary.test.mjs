import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [chart, page, visualCss, embedded, embeddedCss] = await Promise.all([
  readFile(new URL("../app/TeamCharts.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/visual-pass.css", import.meta.url), "utf8"),
  readFile(new URL("../public/engines/larsa-pulse-board-v33.js", import.meta.url), "utf8"),
  readFile(new URL("../public/engines/larsa-pulse-board-v33-summary.css", import.meta.url), "utf8"),
]);

test("Engineering Management timesheets split each employee total by work mode", () => {
  assert.match(page, /const hourSummary = summarizeClockHours\(mineSessions\);/);
  assert.match(page, /office: hourSummary\.office,[\s\S]*online: hourSummary\.online,[\s\S]*site: hourSummary\.site,/);
  assert.match(chart, /chart-mode-office/);
  assert.match(chart, /chart-mode-online/);
  assert.match(chart, /chart-mode-site/);
  assert.match(chart, /chart-mode-office[\s\S]*Office \{hoursLabel\(row\.office\)\}/);
  assert.match(chart, /chart-mode-online[\s\S]*Online \{hoursLabel\(row\.online\)\}/);
  assert.match(chart, /chart-mode-site[\s\S]*Site \{hoursLabel\(row\.site\)\}/);
  assert.doesNotMatch(chart, /chart-mode-values/);
  assert.match(chart, /Print \/ Save PDF/);
  assert.match(chart, /window\.print\(\)/);
  assert.match(visualCss, /\.chart-mode-office \{ background: #22a06b; \}/);
  assert.match(visualCss, /\.chart-mode-online \{ background: #3674e8; \}/);
  assert.match(visualCss, /\.chart-mode-site \{ background: #17181b; \}/);
});

test("Time and Attendance timesheet adds the same summary for the selected period", () => {
  assert.match(embedded, /function employeeSummary\(rows,people\)/);
  assert.match(embedded, /var rows=W\.__v33PeriodRows\|\|periodRows\(st\);/);
  assert.ok(embedded.includes('data-v33-view="calendar"'));
  assert.ok(embedded.includes('data-v33-view="bars"'));
  assert.match(embedded, /view:'calendar'/);
  assert.match(embedded, /if\(st\.view==='bars'\)/);
  assert.ok(embedded.includes('data-v33-print'));
  assert.match(embedded, /W\.print\(\)/);
  assert.ok(embedded.includes("Office '+fmt(row.sums.Office)+'h"));
  assert.ok(embedded.includes("Online '+fmt(row.sums.Online)+'h"));
  assert.ok(embedded.includes("Site '+fmt(row.sums.Site)+'h"));
  assert.doesNotMatch(embedded, /v33-personModeValues/);
  assert.match(embeddedCss, /\.v33-personModeTrack i\.office[\s\S]*#22a06b/);
  assert.match(embeddedCss, /\.v33-personModeTrack i\.online[\s\S]*#3674e8/);
  assert.match(embeddedCss, /\.v33-personModeTrack i\.site[\s\S]*#17181b/);
});

test("embedded presentation remains valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(embedded));
});
