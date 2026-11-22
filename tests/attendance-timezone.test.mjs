import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  ATTENDANCE_TIME_ZONE,
  attendanceDateKey,
  attendanceDateOffset,
  attendanceDateTimeInput,
  attendanceMonthKey,
  attendanceWallDateTimeUtc,
  attendanceWallTimeUtc,
  attendanceWeekKey,
  attendanceReportingWeekStart,
  attendanceReportingWeekSessions,
  splitAttendanceInterval,
  validAttendanceTimeZone,
} from "../lib/attendance-timezone.mjs";

test('repeated history calculations reuse timezone formatters and preserve exact hours',()=>{
  let allocations=0;
  const DateTimeFormat=new Proxy(Intl.DateTimeFormat,{construct(target,args){allocations++;return Reflect.construct(target,args)}});
  const context=vm.createContext({Intl:{DateTimeFormat},Date,Map,Number,String,NaN});
  const source=readFileSync(new URL('../lib/attendance-timezone.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
  vm.runInContext(source,context);
  for(let cycle=0;cycle<8;cycle++)for(let day=1;day<=20;day++){
    const date=`2026-10-${String(day).padStart(2,'0')}`;
    const rows=context.splitAttendanceInterval(`${date}T14:00:00Z`,`${date}T18:00:00Z`);
    assert.equal(rows.reduce((sum,row)=>sum+Date.parse(row.to)-Date.parse(row.from),0),4*3600000);
    assert.equal(context.attendanceDateTimeInput(`${date}T14:00:00Z`),`${date}T09:00`);
  }
  assert.ok(allocations<=3,`formatter allocation must depend on zones/formats, not history rows: ${allocations}`);
  assert.equal(context.validAttendanceTimeZone(''),false);
});

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

test("ISO week numbers stay correct when January first is Friday", () => {
  assert.equal(attendanceWeekKey("2021-01-03T17:00:00Z"), "2020-W53");
  assert.equal(attendanceWeekKey("2021-01-04T17:00:00Z"), "2021-W01");
  assert.equal(attendanceWeekKey("2027-01-04T17:00:00Z"), "2027-W01");
  assert.equal(attendanceWeekKey("2027-12-31T17:00:00Z"), "2027-W52");
});

test("reporting weeks default to Saturday and honor a saved first day across year and DST boundaries", () => {
  assert.equal(attendanceReportingWeekStart("2026-11-11T15:00:00Z"), "2026-11-07");
  assert.equal(attendanceReportingWeekStart("2026-11-11T15:00:00Z", 1), "2026-11-09");
  assert.equal(attendanceReportingWeekStart("2027-01-01T15:00:00Z"), "2026-12-26");
  assert.equal(attendanceReportingWeekStart("2026-03-08T09:00:00Z"), "2026-03-07");
  assert.equal(attendanceReportingWeekStart("2026-11-11T15:00:00Z", 99), "2026-11-07");
});

test("Home and Clock select the same attendance rows on the first day of a reporting week", () => {
  const rows = [
    { date: "2026-11-13", hours: 11.3 },
    { date: "2026-11-14", hours: 3.5 },
    { date: "2026-11-15", hours: 2 },
  ];
  const saturday = "2026-11-14T16:00:00Z";
  assert.deepEqual(attendanceReportingWeekSessions(rows, saturday), [rows[1]]);
  assert.equal(attendanceReportingWeekSessions(rows, saturday).reduce((sum, row) => sum + row.hours, 0), 3.5);
  assert.deepEqual(attendanceReportingWeekSessions(rows, saturday, 1), [rows[0], rows[1]]);
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
  assert.deepEqual(splitAttendanceInterval("2026-07-01T04:30:00Z", "2026-07-01T07:30:00Z", "Not/AZone")
    .map((row) => row.date), ["2026-06-30", "2026-07-01"]);
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

test("correction inputs reject missing days and skipped spring-forward times", () => {
  assert.equal(attendanceWallTimeUtc("2026-03-08", "02:30"), "");
  assert.equal(attendanceWallTimeUtc("2026-02-30", "09:00"), "");
  assert.equal(attendanceDateOffset("2026-02-30", 1), "");
  assert.equal(attendanceDateKey(null), "");
  assert.deepEqual(attendanceReportingWeekSessions([{ date: "" }], null), []);
});

test("the correction editor preserves stored seconds and a repeated hour's offset", () => {
  const secondOccurrence = "2026-11-01T07:30:38.123Z";
  const shown = attendanceDateTimeInput(secondOccurrence);
  assert.equal(shown, "2026-11-01T01:30");
  assert.equal(attendanceWallDateTimeUtc(shown, ATTENDANCE_TIME_ZONE, secondOccurrence), secondOccurrence);
  assert.equal(attendanceWallDateTimeUtc("2026-11-01T01:31", ATTENDANCE_TIME_ZONE, secondOccurrence), "2026-11-01T07:31:00.000Z");
  assert.equal(attendanceWallDateTimeUtc("2026-07-01T09:00:38"), "2026-07-01T14:00:38.000Z");
});

test("native correction and attendance status display stay on the canonical policy", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /attendanceWallTimeUtc\(draft\.date, draft\.from, ATTENDANCE_TIME_ZONE\)/);
  assert.match(page, /timeZone: ATTENDANCE_TIME_ZONE/);
  assert.match(page, /function attendanceTime\(instant: string \| Date\)/);
  assert.match(page, /attendanceTime\(startedAt\)/);
});
