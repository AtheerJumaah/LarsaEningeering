/* Attendance transitions are serialized by Postgres; the browser never
 * chooses a transition from an old localStorage snapshot. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const punchClient = await read("lib/attendance-punch.ts");
const sql = await read("supabase/migrations/repair_012_atomic_attendance_punch.sql");
const punch = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchBreak = useCallback"));
assert.ok(punch.length > 500, "punchClock could not be isolated");

test("each press carries its displayed intent to the atomic server transition", () => {
  assert.match(page, /import \{ recordAttendancePunch, type AttendancePunchInput \} from "\.\.\/lib\/attendance-punch";/);
  assert.match(punch, /const decided: "In" \| "Out" = intent \?\? \(currentLog\?\.status === "In" \? "Out" : "In"\);/);
  assert.match(punch, /status: decided,/);
  assert.match(punch, /await recordAttendancePunch\(event\)/);
  assert.doesNotMatch(punch, /confirmClockState|trueStatus|clockRefusals/);
});

test("a same-state retry is idempotent and concurrent devices serialize by employee", () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_uid, 0\)\)/);
  assert.match(sql, /where e\.client_event_id = p_client_event_id/);
  assert.match(sql, /where e\.uid = p_uid/);
  assert.match(sql, /if found and v_current\.status = p_status then/);
  assert.match(sql, /return query select 'already'::text/);
  assert.match(punchClient, /p_client_event_id: input\.client_event_id/);
});

test("an ambiguous timeout keeps the same event queued for retry", () => {
  assert.match(punch, /const queueKey = attendancePunchQueueKey\(user\.id\);/);
  assert.match(punch, /localStorage\.setItem\(queueKey, JSON\.stringify\(pending\)\)/);
  assert.match(punch, /if \(result\.outcome === "unavailable"/);
  assert.match(punch, /pending\.shift\(\);/);
  assert.match(punchClient, /setTimeout\(\(\) => resolve\(\{ outcome: "unavailable" \}\), 8000\)/);
});

test("the server response repairs local active flags and persists the record", () => {
  assert.match(punch, /const eventId = result\.eventId \|\| event\.client_event_id;/);
  assert.match(punch, /if \(result\.status === "In"\) log\.active = true;/);
  assert.match(punch, /pushSyncedKeyNow\("larsaStaffV8"\);/);
  assert.match(punch, /result\.workMode/);
});

test("clock-in/out remains usable during the first sync, and the iframe uses the same writer", () => {
  const button = page.slice(page.indexOf('className={`clock-punch'), page.indexOf('</button>', page.indexOf('className={`clock-punch')));
  assert.match(button, /disabled=\{punching\}/);
  assert.doesNotMatch(button, /clockReady/);
  assert.match(page, /void punchClockGuarded\(mode, note \|\| "", intent\);/);
});
