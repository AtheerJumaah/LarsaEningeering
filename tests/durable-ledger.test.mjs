import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The durable attendance ledger and the write-path hardening: the permanent
 * fixes for the Aug 6–7 account/attendance loss. Attendance survives blob
 * overwrites, account recreation, auth changes and stale devices — and old
 * cached bundles can no longer write the shared state at all. */

test("every staff-blob write is tapped and new punches are queued idempotently", async () => {
  const ledger = await read("lib/ledger.ts");
  assert.match(ledger, /window\.localStorage\.setItem = function ledgerPatchedSetItem/);
  assert.match(ledger, /if \(key === "larsaStaffV8"\)/);
  // Idempotent delivery: the punch's own entropy-rich id is the conflict key.
  assert.match(ledger, /\.upsert\(queue, \{ onConflict: "client_event_id", ignoreDuplicates: true \}\)/);
  // Offline safety: a queue in localStorage, flushed on write, timer, and reconnect.
  assert.match(ledger, /larsaLedgerQueueV1/);
  assert.match(ledger, /addEventListener\("online", onOnline\)/);
});

test("boot reconciliation restores ledger events the blob lost, honouring deliberate removals", async () => {
  const ledger = await read("lib/ledger.ts");
  assert.match(ledger, /export async function reconcileStoreFromLedger/);
  assert.match(ledger, /if \(!id \|\| present\.has\(id\) \|\| removed\.has\(id\)\) return;/);
  assert.match(ledger, /recovery: "ledger-restore",/);
  // Open shifts are recomputed so a restored open session stays live.
  /* The recompute now self-heals the denormalized flags on EVERY reconcile
     (69 stale active flags were live in production), writing only when a
     flag or a restore actually changed something. */
  assert.match(ledger, /openByUid\.forEach\(\(log\) => \{ if \(log\) openLogs\.add\(log\); \}\);/);
  assert.match(ledger, /if \(restored \|\| flagsChanged\) \{/);
  const page = await read("app/page.tsx");
  assert.match(page, /reconcileStoreFromLedger\(\)\.then\(\(\{ restored \}\) => \{/);
  assert.match(page, /const cleanupLedger = initAttendanceLedger\(\);/);
});

test("deliberate session removals tombstone the ids and are audited — reduce is possible, silent loss is not", async () => {
  const page = await read("app/page.tsx");
  const tombstones = page.match(/markLogsRemoved\(store as \{ removedLogIds\?: string\[\] \}, Array\.from\(drop\)/g) || [];
  assert.equal(tombstones.length, 2, "both removal paths must tombstone");
  const audits = page.match(/attendance\.session_removed/g) || [];
  assert.ok(audits.length >= 2, "both removal paths must audit");
});

test("the database migration makes the ledger append-only and locks direct app_state writes", async () => {
  const migration = await read("supabase/migrations/repair_002_durable_attendance_ledger_and_write_hardening.sql");
  assert.match(migration, /create table if not exists public\.attendance_events/);
  assert.match(migration, /client_event_id text not null unique/);
  assert.match(migration, /attendance_events is append-only/);
  assert.match(migration, /before update or delete on public\.attendance_events/);
  assert.match(migration, /revoke update, delete, truncate on public\.attendance_events from authenticated/);
  // The CAS RPC became SECURITY DEFINER so client table grants could be revoked.
  assert.match(migration, /security definer set search_path = public/);
  assert.match(migration, /revoke insert, update, delete, truncate on public\.app_state from anon, authenticated/);
});

test("verification is keyed to the permanent identity (normalized email), with configurable units", async () => {
  const policy = await read("supabase/functions/auth-policy/index.ts");
  assert.match(policy, /\.eq\("normalized_email", email\)/);
  assert.match(policy, /const stamp = rows\.reduce/);
  assert.match(policy, /function businessDaysElapsed/);
  assert.match(policy, /const WEEKEND = new Set\(\[1, 2\]\); \/\/ Friday, Saturday/);
  assert.match(policy, /interval_unit/);
  // Only a genuinely accepted code moves the clock; sign-in never writes it.
  const code = await read("supabase/functions/auth-code/index.ts");
  assert.match(code, /stampPeriodicVerification\(String\(payload\.userId\), email\)/);
  const client = await read("lib/verification.ts");
  assert.match(client, /email: String\(user\.email \|\| ""\)\.trim\(\)\.toLowerCase\(\)/);
  const page = await read("app/page.tsx");
  const passes = page.match(/checkVerification\(\{ id: [A-Za-z]+\.id, email: [A-Za-z]+\.email/g) || [];
  assert.equal(passes.length, 4, "all four verification checks must carry the email");
});

test("business-day arithmetic: Sun–Thu count, Friday and Saturday never do", async () => {
  // Reimplement the function's day math independently and compare key facts:
  // Aug 6 2026 is a Thursday in Baghdad; +1 business day lands past the
  // Fri/Sat weekend. Epoch day % 7: 0=Thu 1=Fri 2=Sat.
  const offset = 3 * 3600_000;
  const dayIndex = (iso) => Math.floor((new Date(iso).getTime() + offset) / 86_400_000);
  assert.equal(dayIndex("2026-08-06T12:00:00Z") % 7, 0, "Aug 6 2026 must map to Thursday");
  assert.equal(dayIndex("2026-08-07T12:00:00Z") % 7, 1, "Aug 7 2026 must map to Friday");
  const businessDays = (fromIso, toIso) => {
    let count = 0;
    for (let day = dayIndex(fromIso) + 1; day <= dayIndex(toIso); day++) {
      if (day % 7 !== 1 && day % 7 !== 2) count++;
    }
    return count;
  };
  // Thursday → Sunday spans the weekend: exactly ONE business day elapsed.
  assert.equal(businessDays("2026-08-06T12:00:00Z", "2026-08-09T12:00:00Z"), 1);
  // Thursday → next Thursday: a full working week, five business days.
  assert.equal(businessDays("2026-08-06T12:00:00Z", "2026-08-13T12:00:00Z"), 5);
});
