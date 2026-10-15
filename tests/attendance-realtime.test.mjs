import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ledger = readFileSync(new URL("../lib/ledger.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/repair_021_attendance_realtime.sql", import.meta.url), "utf8");

test("attendance realtime applies only the small append-only ledger event", () => {
  assert.match(ledger, /table: "attendance_events"/);
  assert.match(ledger, /event: "INSERT"/);
  assert.match(ledger, /applyRealtimeAttendanceEvent\(row\)/);
  assert.match(ledger, /recovery: "realtime-ledger"/);
  assert.match(ledger, /store\.logs\.some\(\(log\) => String\(log\?\.id \|\| ""\) === id\)/);
  assert.match(ledger, /larsa:attendance-realtime/);
  assert.match(ledger, /duplicate realtime delivery still needs to repair active flags/);
});

test("the React shell repaints immediately when a realtime attendance event arrives", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /window\.addEventListener\("larsa:attendance-realtime"/);
  assert.match(page, /window\.removeEventListener\("larsa:attendance-realtime"/);
});

test("production migration publishes attendance_events without changing its data", () => {
  assert.match(migration, /alter publication supabase_realtime add table public\.attendance_events/);
  assert.match(migration, /to_regclass\('public\.attendance_events'\)/);
  assert.doesNotMatch(migration, /delete from|truncate|drop table|update public\.attendance_events/i);
});
