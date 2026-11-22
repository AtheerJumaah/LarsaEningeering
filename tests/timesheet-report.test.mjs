import test from "node:test";
import assert from "node:assert/strict";
import { reportDocument, summarizeReport } from "../public/engines/timesheet-report.mjs";

const period = { from: "2024-05-04", to: "2024-05-10" };
const base = { uid: "p1", name: "Same Name", mode: "Office", start: "2024-05-04T22:00:00Z",
  end: "2024-05-05T07:30:00Z", day: "2024-05-04", hours: 4.25, status: "Closed" };

test("report adds only the selected daily net hours and counts an overnight shift once", () => {
  const entries = [base, { ...base, day: "2024-05-05", hours: 2.5 }];
  const a = summarizeReport({ ...period, entries });
  assert.equal(a.shifts, 1);
  assert.equal(a.totals.hours, 6.75);
  assert.equal(summarizeReport({ ...period, entries: entries.slice(1) }).totals.hours, 2.5);
  assert.equal(a.totals.Office, 6.75);
});

test("permission-filtered people with duplicate names stay distinct and exceptions are per shift", () => {
  const rows = [base, { ...base, uid: "p2", end: null, status: "Needs review", hours: 0, mode: "Other" }];
  const a = summarizeReport({ ...period, entries: rows, people: [{ uid: "p3", name: "Zero hours" }] });
  assert.equal(a.people.length, 3);
  assert.equal(a.flagged, 1);
  assert.equal(a.shifts, 2);
  assert.match(reportDocument({ ...period, entries: rows }), /Other h/);
  assert.match(reportDocument({ ...period, entries: rows }), /<td>—<\/td><td>Needs review/);
});

test("filtered report escapes employee text, includes all sessions beyond the 120-row screen cap, and supports an empty period", () => {
  const entries = Array.from({ length: 145 }, (_, i) => ({ ...base, uid: "id" + i, name: "Person " + i }));
  entries[144].name = 'Final <person>';
  const html = reportDocument({ ...period, entries, mode: "Office", search: '<team>' });
  assert.match(html, /Final &lt;person&gt;/);
  assert.equal((html.match(/<td>Closed<\/td>/g) || []).length, 145);
  assert.match(html, /Employee filter · &lt;team&gt;/);
  assert.doesNotMatch(html, /<person>|<team>/);
  assert.match(reportDocument({ ...period, entries: [] }), /No attendance entries match/);
  assert.match(reportDocument({ ...period, entries: [base], summaryOnly: true }), /id="detail" hidden/);
});

test("appearance and charts render independently with totals from the same filtered attendance", () => {
  const entries = [
    { ...base, name: "Example A", hours: 6 },
    { ...base, uid: "p2", name: "Example B", mode: "Online", hours: 2 },
    { ...base, uid: "p3", name: "Example C", mode: "Site", hours: 0 },
  ];
  const report = { ...period, entries, summaryOnly: true };
  const plain = reportDocument(report);
  assert.match(plain, /class="charts" hidden/);
  const barsOnly = reportDocument(report, undefined, { palette: "monochrome", bar: true });
  assert.match(barsOnly, /data-palette="monochrome"/);
  assert.match(barsOnly, /id="bar-chart">/);
  assert.match(barsOnly, /id="pie-chart" hidden/);
  assert.match(barsOnly, /bar-value">6\.00 h/);
  assert.match(barsOnly, /id="detail" hidden/);
  const pieOnly = reportDocument(report, undefined, { pie: true });
  assert.match(pieOnly, /id="bar-chart" hidden/);
  assert.match(pieOnly, /id="pie-chart">/);
  assert.match(pieOnly, /Office<small>6\.00 h<\/small><\/span>\s*<b>75%/);
  assert.match(pieOnly, /Online<small>2\.00 h<\/small><\/span>\s*<b>25%/);
  assert.doesNotMatch(pieOnly, /data-mode="site"/);
});

test("the bar chart fits a large team while the summary retains every employee", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ ...base, uid: "employee-" + i, name: "Person " + i, hours: i + 1 }));
  const html = reportDocument({ ...period, entries }, undefined, { bar: true });
  assert.match(html, /Top 8 of 10 employees/);
  assert.equal((html.match(/class="bar-name"/g) || []).length, 8);
  assert.match(html, /<th scope="row">Person 0<\/th>/);
  const empty = reportDocument({ ...period, entries: [] }, undefined, { pie: true });
  assert.match(empty, /id="pie-chart"><figcaption>Net hours by work mode<\/figcaption><p class="chart-empty">/);
  assert.doesNotMatch(empty, /conic-gradient/);
});
