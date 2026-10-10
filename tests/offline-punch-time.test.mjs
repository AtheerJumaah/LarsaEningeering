import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const migration = await read("supabase/migrations/repair_013_preserve_offline_punch_time.sql");
const client = await read("lib/attendance-punch.ts");
const page = await read("app/page.tsx");
const sqlRunner = await read("tests/run-sql-tests.sh");
const sqlTest = await read("tests/atomic-attendance-punch-sql.test.sql");
const punch = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchClockGuarded"));

test("offline punches preserve captured time while skewed or old times go to review", () => {
  assert.match(migration, /p_occurred_at > v_received_at \+ interval '2 minutes'/);
  assert.match(migration, /p_occurred_at < v_received_at - interval '36 hours'/);
  assert.match(migration, /p_occurred_at <= v_current\.occurred_at/);
  assert.match(migration, /least\(p_occurred_at, v_received_at\)/);
  assert.match(migration, /client_event_id, occurred_at, uid[\s\S]*?p_client_event_id, v_occurred_at, p_uid/);
  assert.match(client, /String\(error\.code \|\| ""\) === "22023"/);
  assert.match(client, /outcome: "needs_review"/);
  assert.match(sqlRunner, /repair_013_preserve_offline_punch_time/);
  assert.match(sqlTest, /captured punch time was not preserved/);
  assert.match(sqlTest, /offline clock-out time was not preserved/);
  assert.match(sqlTest, /future punch should have been rejected/);
});

test("a rejected offline event is retained for review and removed from automatic retries", () => {
  assert.match(punch, /result\.outcome === "needs_review"/);
  assert.match(punch, /attendancePunchReviewKey\(user\.id\)/);
  assert.match(punch, /review\.push\(\{ \.\.\.event, needs_review: true/);
  assert.match(punch, /pending\.shift\(\);\s*localStorage\.setItem\(queueKey, JSON\.stringify\(pending\)\)/);
  assert.match(page, /if \(queued\[0\]\?\.needs_review\) return;/);
});

