import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  durationMsBetween, minutesFromMs, formatMinutes, formatDurationMs, formatHours, decimalHoursFromMinutes,
} from "../lib/duration.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The attendance specification's own examples, verbatim. Durations come from
 * exact timestamps; totals are summed in exact units before formatting; the
 * normal display is HR/MIN, never decimal hours. */

test("clock-in/out durations match the specification examples exactly", () => {
  const cases = [
    ["2026-08-07T08:00:00Z", "2026-08-07T08:30:00Z", "30 min"],
    ["2026-08-07T08:00:00Z", "2026-08-07T09:00:00Z", "1 hr"],
    ["2026-08-07T08:00:00Z", "2026-08-07T09:15:00Z", "1 hr 15 min"],
    ["2026-08-07T08:00:00Z", "2026-08-07T09:20:00Z", "1 hr 20 min"],
    ["2026-08-07T08:00:00Z", "2026-08-07T10:05:00Z", "2 hr 5 min"],
    ["2026-08-07T08:00:00Z", "2026-08-07T16:30:00Z", "8 hr 30 min"],
  ];
  for (const [start, end, expected] of cases) {
    assert.equal(formatDurationMs(durationMsBetween(start, end)), expected, `${start} → ${end}`);
  }
});

test("overnight sessions cross midnight without resetting or going negative", () => {
  const ms = durationMsBetween("2026-08-06T23:30:00Z", "2026-08-07T01:15:00Z");
  assert.equal(ms, 105 * 60000);
  assert.equal(formatDurationMs(ms), "1 hr 45 min");
  // Malformed or reversed timestamps clamp to zero rather than going negative.
  assert.equal(durationMsBetween("2026-08-07T02:00:00Z", "2026-08-07T01:00:00Z"), 0);
});

test("multiple sessions total exactly: 1 hr 20 min + 45 min = 2 hr 5 min (125 minutes)", () => {
  const first = durationMsBetween("2026-08-07T08:00:00Z", "2026-08-07T09:20:00Z");
  const second = durationMsBetween("2026-08-07T10:00:00Z", "2026-08-07T10:45:00Z");
  const totalMinutes = minutesFromMs(first + second);
  assert.equal(totalMinutes, 125);
  assert.equal(formatMinutes(totalMinutes), "2 hr 5 min");
  // And the other spec example: 30 min + 45 min = 1 hr 15 min.
  assert.equal(formatMinutes(30 + 45), "1 hr 15 min");
});

test("the recovered incident session: 08:30 → 17:00 is 8 hr 30 min (510 minutes), never 8.5 hr", () => {
  const ms = durationMsBetween("2026-08-06T08:30:00+03:00", "2026-08-06T17:00:00+03:00");
  assert.equal(minutesFromMs(ms), 510);
  assert.equal(formatDurationMs(ms), "8 hr 30 min");
  // The decimal form exists only as a derived export value.
  assert.equal(decimalHoursFromMinutes(510), "8.50");
});

test("daily/weekly totals format per the specification (495→8 hr 15 min, 60→1 hr, 35→35 min, 0→0 min)", () => {
  assert.equal(formatMinutes(495), "8 hr 15 min");
  assert.equal(formatMinutes(60), "1 hr");
  assert.equal(formatMinutes(35), "35 min");
  assert.equal(formatMinutes(0), "0 min");
});

test("hours-and-minutes are never confused: 1.30 decimal hours is 1 hr 18 min, and 1 hr 15 min is 1.25", () => {
  assert.equal(formatHours(1.3), "1 hr 18 min");      // .30 h is 18 minutes, not 30
  assert.equal(decimalHoursFromMinutes(75), "1.25");  // 1 hr 15 min → 1.25 for exports
  assert.equal(decimalHoursFromMinutes(30), "0.50");  // 30 min → 0.50 for exports
});

test("the float-hour bridge sums exactly (no cumulative rounded-decimal drift)", () => {
  // Sum many 1 hr 20 min sessions as the app does (exact ms/3.6e6 floats),
  // format once at the end: 9 × 80 min = 720 min = 12 hr exactly.
  const sessionHours = durationMsBetween("2026-08-07T08:00:00Z", "2026-08-07T09:20:00Z") / 3600000;
  const total = Array.from({ length: 9 }, () => sessionHours).reduce((sum, hours) => sum + hours, 0);
  assert.equal(formatHours(total), "12 hr");
});

test("the app displays attendance in HR/MIN — no decimal-hour strings remain on normal screens", async () => {
  const page = await read("app/page.tsx");
  // Every stat tile, table cell, and summary now formats through the engine.
  for (const marker of [
    "<b>{formatHours(todayHours)}</b>", "<b>{formatHours(weekHours)}</b>",
    "`${formatHours(session.hours)} worked`", "<td>{formatHours(session.hours)}</td>",
    "<b>{formatHours(row.hours)}</b>",
  ]) assert.ok(page.includes(marker), `missing: ${marker}`);
  // And the old decimal displays are gone.
  assert.ok(!/toFixed\(2\)\}\s*h\b/.test(page), "a decimal-hour display survived");
  assert.ok(!/toFixed\(1\)\}\s*h\b/.test(page), "a decimal-hour display survived");
});
