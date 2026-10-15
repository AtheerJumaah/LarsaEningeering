import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/repair_022_attendance_single_snapshot.sql", import.meta.url),
  "utf8",
);

test("attendance RPC derives shift and current status from one effective snapshot", () => {
  assert.match(migration, /with effective as materialized/i);
  assert.equal((migration.match(/from public\.attendance_effective_events\(p_uid\)/g) || []).length, 1);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_uid, 0\)\)/);
  assert.match(migration, /where e\.status in \('In','Out'\)/);
  assert.match(migration, /p_status in \('In','Out'\)/);
  assert.match(migration, /client_event_id,occurred_at,uid/);
});
