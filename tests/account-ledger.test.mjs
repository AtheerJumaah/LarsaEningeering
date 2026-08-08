import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* Accounts must never be silently lost again.
 *
 * Attendance already had this protection and it demonstrably worked: when a
 * stale device overwrote the shared blob, the punches walked back out of the
 * append-only ledger. Accounts had no equivalent — they existed only inside
 * that one overwritable JSON document — so on 8 August accounts created
 * during the day were repeatedly erased while the punches those same people
 * made survived untouched. These tests hold the twin protection in place. */

const ledger = await read("lib/accounts-ledger.ts");
const page = await read("app/page.tsx");
const migration = await read("supabase/migrations/repair_007_durable_account_ledger.sql");

test("the database physically refuses to delete an account row", () => {
  assert.match(migration, /create trigger staff_accounts_block_delete\s*\n\s*before delete on public\.staff_accounts/);
  assert.match(migration, /raise exception 'staff_accounts is append-only: accounts are tombstoned, never deleted'/);
  // Not even a direct write can forge a removal: the tombstone columns are
  // reverted on any update that did not come through the RPC.
  assert.match(migration, /create trigger staff_accounts_guard_tombstone\s*\n\s*before update on public\.staff_accounts/);
  assert.match(migration, /if current_setting\('larsa\.tombstone_ok', true\) is distinct from 'yes' then\s*\n\s*new\.removed_at\s*:= old\.removed_at;/);
  // And there is no INSERT/UPDATE policy at all — every write goes via the RPC.
  assert.ok(!/create policy \w+ on public\.staff_accounts\s*\n\s*for (insert|update)/.test(migration),
    "no direct insert/update policy may exist on staff_accounts");
});

test("a half-loaded client can never hollow out a good record", () => {
  /* The upsert coalesces: a blank name, email, role or username from a
     partially-loaded page leaves the stored value alone rather than
     replacing a real one with an empty string. */
  assert.match(migration, /name\s+= coalesce\(nullif\(excluded\.name, ''\), sa\.name\)/);
  assert.match(migration, /normalized_email = coalesce\(nullif\(excluded\.normalized_email, ''\), sa\.normalized_email\)/);
  assert.match(migration, /record\s+= case when excluded\.record = '\{\}'::jsonb then sa\.record else excluded\.record end/);
  // History never moves.
  assert.match(migration, /new\.first_seen_at := old\.first_seen_at;/);
});

test("an account missing from the blob is never treated as a deletion", () => {
  /* This is the whole point. Absence is the symptom of the bug, so it can
     never be the trigger for removal. Only an explicit tombstone stops a
     restore. */
  assert.match(ledger, /\.is\("removed_at", null\)/);
  assert.match(ledger, /if \(!uid \|\| present\.has\(uid\) \|\| removed\.has\(uid\)\) return;/);
  assert.match(ledger, /const removed = new Set\(\(store\.removedUserIds \|\| \[\]\)\.map\(String\)\);/);
  // Restoring must never manufacture a second account for one person.
  assert.match(ledger, /if \(email && liveEmails\.has\(email\)\) return;/);
});

test("every blob write delivers its accounts to the ledger, with retry", () => {
  assert.match(ledger, /export function accountsTapStaffWrite\(rawValue: string\)/);
  assert.match(ledger, /if \(key === "larsaStaffV8"\) \{\s*\n\s*try \{ accountsTapStaffWrite\(value\); \}/);
  // Queued in localStorage first, so an account created offline still lands.
  assert.match(ledger, /const QUEUE_KEY = "larsaAccountQueueV1";/);
  assert.match(ledger, /window\.setInterval\(\(\) => \{ void flushAccountQueue\(\); \}, 60_000\)/);
  assert.match(ledger, /window\.addEventListener\("online", onOnline\);/);
  // The tap wraps the CURRENT setItem so it composes with the sync layer's
  // wrapper and the attendance ledger's, rather than replacing either.
  assert.match(ledger, /const previousSetItem = window\.localStorage\.setItem\.bind\(window\.localStorage\);/);
});

test("the app installs both ledgers and restores accounts on every sync settle", () => {
  assert.match(page, /const cleanupLedger = initAttendanceLedger\(\);\s*\n\s*const cleanupAccounts = initAccountLedger\(\);/);
  assert.match(page, /return \(\) => \{ cleanupAccounts\(\); cleanupLedger\(\); cleanup\(\); \};/);
  assert.match(page, /reconcileAccountsFromLedger\(\)\.then\(\(\{ restored, names \}\) => \{/);
  // Restoration is reported to the person, not done silently.
  assert.match(page, /account was restored from the durable ledger/);
});

test("a permanent delete tombstones on the server as well as locally", () => {
  /* The local list alone would not hold: another browser would restore the
     account from the ledger seconds later. Both halves, or neither works. */
  assert.match(page, /markAccountsRemoved\(store, \[target\.id\]\);/);
  assert.match(page, /void tombstoneAccount\(target\.id, actor\.email \|\| actor\.name \|\| actor\.id,/);
  // And it is still Super-Admin-only, and still refuses the owner account.
  assert.match(page, /if \(!actor \|\| actor\.access !== "Super Admin"\) \{\s*\n\s*notify\("Only the Super Admin can permanently delete an account\."\);/);
  assert.match(page, /if \(existing\.access === "Super Admin"\) \{ notify\("The protected owner account cannot be deleted\."\); return false; \}/);
  // Offboarding and the recycling bin keep the account in the directory, so
  // they must NOT tombstone — only the permanent delete may.
  const tombstoneCalls = (page.match(/tombstoneAccount\(/g) || []).length;
  assert.equal(tombstoneCalls, 1, "exactly one call site may tombstone: the permanent delete");
});

test("the failure direction is chosen: tidiness is lost before people are", () => {
  /* If a tombstone were ever itself lost, a removed account comes back and an
     administrator removes it again. The opposite bias — treating a missing
     tombstone as permission to erase — is what caused this incident. */
  assert.match(ledger, /A real person's account never\s*\n \* silently vanishes\./);
  assert.match(migration, /A real person's account never silently disappears\./);
});
