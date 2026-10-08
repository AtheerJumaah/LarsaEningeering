/* Clock actions should be confirmed once by the server, with ambiguous writes
 * safely retried under the same idempotency key. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const client = await read("lib/attendance-punch.ts");
const punch = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));

 test("a clock action is recorded by the atomic server writer", () => {
  assert.match(punch, /await recordAttendancePunch\(event\)/);
  assert.match(punch, /status: decided,/);
  assert.match(client, /client\.rpc\("record_attendance_punch"/);
  assert.doesNotMatch(punch, /confirmClockState|trueStatus|clockRefusals/);
});

test("a retry reuses the pending event and does not lose the employee's note", () => {
  assert.match(punch, /const queueKey = attendancePunchQueueKey\(user\.id\);/);
  assert.match(punch, /if \(queue\[queue\.length - 1\]\?\.status !== decided\)/);
  assert.match(punch, /client_event_id: `p\$\{user\.id\}\$\{Date\.now\(\)\}/);
  assert.match(punch, /note: note\.trim\(\) \|\| null,/);
  assert.match(punch, /Your clock action is not confirmed yet\./);
});

test("the same server state refreshes the screen without another press", () => {
  assert.match(punch, /if \(lastOutcome === "already"\)/);
  assert.match(punch, /Already clocked in/);
  assert.match(punch, /Already clocked out/);
  assert.match(punch, /refreshStaffEngine\(\);/);
});

test("the atomic writer uses server time, serializes by employee, and treats retries idempotently", async () => {
  assert.match(punch, /occurred_at: serverNowIso\(\)/);
  assert.match(client, /p_client_event_id: input\.client_event_id/);
  const sql = await read("supabase/migrations/repair_012_atomic_attendance_punch.sql");
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_uid, 0\)\)/);
  assert.match(sql, /if found and v_current\.status = p_status then/);
});
