import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/repair_022_attendance_single_snapshot.sql", import.meta.url),
  "utf8",
);
const correctionIndex = fs.readFileSync(
  new URL("../supabase/migrations/repair_023_attendance_correction_index.sql", import.meta.url),
  "utf8",
);
const latencyHardening = fs.readFileSync(
  new URL("../supabase/migrations/20261016110000_attendance_latency_indexes.sql", import.meta.url),
  "utf8",
);
const removedIds = fs.readFileSync(
  new URL("../supabase/migrations/20261016123000_attendance_removed_ids_index.sql", import.meta.url),
  "utf8",
);
const removedIdsFix = fs.readFileSync(
  new URL("../supabase/migrations/20261016124500_attendance_removed_ids_trigger_fix.sql", import.meta.url),
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

test("attendance corrections use a compact indexed overlay instead of expanding the staff blob", () => {
  assert.match(correctionIndex, /create table if not exists public\.attendance_corrections/i);
  assert.match(correctionIndex, /primary key/);
  assert.match(correctionIndex, /create index if not exists attendance_corrections_effective_idx/i);
  assert.match(correctionIndex, /create trigger attendance_corrections_refresh/i);
  assert.match(correctionIndex, /left join public\.attendance_corrections/i);
  assert.doesNotMatch(
    correctionIndex.slice(correctionIndex.indexOf("create or replace function public.attendance_effective_events")),
    /jsonb_array_elements/i,
  );
});

test("attendance readers are indexed and non-attendance blob edits skip correction expansion", () => {
  assert.match(latencyHardening, /create index if not exists attendance_events_inserted_at_idx/i);
  assert.match(latencyHardening, /tg_op = 'UPDATE'/i);
  assert.match(latencyHardening, /old\.data->'logs'/i);
  assert.match(latencyHardening, /new\.data->'logs'/i);
});

test("attendance punches use an indexed tombstone lookup instead of parsing the staff blob", () => {
  assert.match(removedIds, /create table if not exists public\.attendance_removed_events/i);
  assert.match(removedIds, /create trigger attendance_removed_events_refresh/i);
  assert.match(removedIds, /from public\.attendance_removed_events r/i);
  assert.match(removedIds, /patched := replace\([\s\S]*attendance_removed_events r/i);
  assert.match(removedIdsFix, /create or replace function public\.refresh_attendance_removed_events/i);
  assert.match(removedIdsFix, /on conflict \(client_event_id\) do nothing/i);
  assert.doesNotMatch(removedIdsFix, /delete from public\.attendance_removed_events/i);
});
