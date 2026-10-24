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
  assert.match(punch, /if \(intent === undefined\) \{[\s\S]*await confirmClockState\(user\.id, initialStore\?\.removedLogIds \|\| \[\]\)/);
  assert.match(punch, /if \(!confirmed\.reached \|\| !confirmed\.status\) \{[\s\S]*return false;/);
  assert.match(punch, /\} else \{\s*decided = intent;\s*\}/);
  assert.match(client, /client\.rpc\("record_attendance_action"/);
});

test("a retry reuses the pending event and does not lose the employee's note", () => {
  assert.match(punch, /const queueKey = attendancePunchQueueKey\(user\.id\);/);
  assert.match(punch, /if \(!quiet && queue\[queue\.length - 1\]\?\.status !== decided\)/);
  assert.match(punch, /client_event_id: `p\$\{user\.id\}\$\{Date\.now\(\)\}/);
  assert.match(punch, /note: note\.trim\(\) \|\| null,/);
  assert.match(punch, /Clock action recorded; confirming with the server\./);
});

test("the clock button explains a slow confirmation instead of showing a frozen Saving label", () => {
  // The durable local queue is the user-facing hand-off. The button is freed
  // immediately; server confirmation continues in the background and never
  // blocks the renderer behind a slow RPC/auth refresh.
  assert.match(page, /punching \? "Saving locally…"/);
  assert.match(page, /Clock action saved locally; confirming in the background/);
  assert.match(page, /saved locally and will retry automatically/);
  assert.doesNotMatch(page, /Confirming Clock (?:In|Out)…/);
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
  const sql = await read("supabase/migrations/repair_014_attendance_chronology_audit.sql");
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_uid, 0\)\)/);
  assert.match(sql, /if v_current\.status=p_status then/);
});
