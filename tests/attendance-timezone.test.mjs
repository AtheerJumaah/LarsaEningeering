import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTENDANCE_TIME_ZONE,
  attendanceDateKey,
  attendanceDateTimeInput,
  attendanceMonthKey,
  attendanceWallDateTimeUtc,
  attendanceWallTimeUtc,
  attendanceWeekKey,
  splitAttendanceInterval,
  validAttendanceTimeZone,
} from "../lib/attendance-timezone.mjs";

test("the proposed canonical attendance zone is explicit and valid", () => {
  assert.equal(ATTENDANCE_TIME_ZONE, "America/Chicago");
  assert.equal(validAttendanceTimeZone(ATTENDANCE_TIME_ZONE), true);
});

test("calendar grouping uses the canonical zone, not the browser zone", () => {
  const instant = "2026-07-01T04:30:00.000Z";
  assert.equal(attendanceDateKey(instant), "2026-06-30");
  assert.equal(attendanceDateKey(instant, "Asia/Baghdad"), "2026-07-01");
  assert.equal(attendanceMonthKey(instant), "2026-06");
  assert.equal(attendanceWeekKey(instant), "2026-W27");
});

test("overnight sessions split at canonical midnight without changing total duration", () => {
  const rows = splitAttendanceInterval("2026-07-01T04:30:00.000Z", "2026-07-01T07:30:00.000Z");
  assert.deepEqual(rows.map((row) => row.date), ["2026-06-30", "2026-07-01"]);
  assert.equal(Date.parse(rows[0].to) - Date.parse(rows[0].from), 30 * 60 * 1000);
  assert.equal(Date.parse(rows[1].to) - Date.parse(rows[1].from), 150 * 60 * 1000);
  assert.equal(Date.parse(rows.at(-1).to) - Date.parse(rows[0].from), 3 * 60 * 60 * 1000);
});

test("DST changes do not create a false extra calendar segment", () => {
  const rows = splitAttendanceInterval("2026-03-08T05:00:00.000Z", "2026-03-08T10:00:00.000Z");
  assert.deepEqual(rows.map((row) => row.date), ["2026-03-07", "2026-03-08"]);
  assert.equal(Date.parse(rows.at(-1).to) - Date.parse(rows[0].from), 5 * 60 * 60 * 1000);
});

test("an invalid configured zone falls back safely to the proposed canonical zone", () => {
  assert.equal(validAttendanceTimeZone("Not/AZone"), false);
  assert.equal(attendanceDateKey("2026-07-01T04:30:00.000Z", "Not/AZone"), "2026-06-30");
});

test("correction wall times become UTC instants using Central standard and daylight offsets", () => {
  assert.equal(attendanceWallTimeUtc("2026-01-15", "09:00"), "2026-01-15T15:00:00.000Z");
  assert.equal(attendanceWallTimeUtc("2026-07-01", "09:00"), "2026-07-01T14:00:00.000Z");
  assert.equal(attendanceWallTimeUtc("2026-07-01", "09:00", "Asia/Baghdad"), "2026-07-01T06:00:00.000Z");
});

test("datetime-local attendance controls round-trip in the canonical zone", () => {
  const instant = "2026-07-01T14:00:00.000Z";
  assert.equal(attendanceDateTimeInput(instant), "2026-07-01T09:00");
  assert.equal(attendanceWallDateTimeUtc(attendanceDateTimeInput(instant)), instant);
});

test("native correction and attendance status display stay on the canonical policy", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /attendanceWallTimeUtc\(draft\.date, draft\.from, ATTENDANCE_TIME_ZONE\)/);
  assert.match(page, /timeZone: ATTENDANCE_TIME_ZONE/);
  assert.match(page, /function attendanceTime\(instant: string \| Date\)/);
  assert.match(page, /attendanceTime\(openClock\.clockIn\)/);
});
