import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

/* The current application has a deliberate compatibility boundary: local
 * employee sign-in is not Supabase Auth sign-in, so the browser first uses an
 * anonymous Supabase session for sync and attendance RPC access. A future
 * identity migration must replace this contract as one coordinated rollout;
 * partially requiring a mapped auth user would lock out existing staff. */
test("attendance identity migration is not partially enforced", async () => {
  const schema = await read("supabase/schema.sql");
  const sync = await read("lib/supabase/sync.ts");
  const punch = await read("lib/attendance-punch.ts");
  const action = await read("supabase/migrations/repair_014_attendance_chronology_audit.sql");
  const legacy = await read("supabase/migrations/repair_020_retire_legacy_attendance_writer.sql");

  assert.match(schema, /Anonymous auth must be turned on/);
  assert.match(sync, /signInAnonymously\(\)/);
  assert.match(punch, /signInAnonymously\(\)/);
  assert.match(action, /grant execute on function public\.record_attendance_action[\s\S]*to anon, authenticated/);
  assert.match(legacy, /security invoker/);
  assert.match(legacy, /revoke all on function public\.attendance_punch[\s\S]*from public, anon/);

  /* There is intentionally no staff_auth_identity/current_staff_uid contract
     in the production migration set yet. This assertion is a tripwire against
     adding only half of the cutover (for example, a DB check without the
     real-auth enrollment and client session changes). */
  const migrationFiles = await readdir(new URL("../supabase/migrations", import.meta.url));
  const migrationText = (await Promise.all(migrationFiles
    .filter((file) => file.endsWith(".sql"))
    .map((file) => read(`supabase/migrations/${file}`)))).join("\n");
  assert.doesNotMatch(migrationText, /staff_auth_identity|current_staff_uid/);
});

test("the live and queued attendance paths name the same authoritative writer", async () => {
  const punch = await read("lib/attendance-punch.ts");
  const ledger = await read("lib/ledger.ts");
  assert.match(punch, /client\.rpc\("record_attendance_action"/);
  assert.match(ledger, /client\.rpc\("record_attendance_action"/);
  assert.doesNotMatch(ledger, /\.upsert\(queue, \{ onConflict: "client_event_id", ignoreDuplicates: true \}\)/);
});
