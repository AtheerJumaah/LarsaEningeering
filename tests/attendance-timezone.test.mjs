import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENDANCE_TIME_ZONE,
  attendanceDateKey,
  attendanceMonthKey,
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
