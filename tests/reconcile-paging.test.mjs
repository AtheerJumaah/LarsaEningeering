/* Larsa Control — reconciliation must see the NEWEST punches, not the oldest.
 *
 * This is the defect behind the recurring "engineers can't clock out": a
 * person clocks out, the Out reaches the durable append-only ledger, but for
 * some transient reason (a losing CAS on the app_state push, a stale-device
 * wholesale overwrite) it never sticks in the shared staff blob. Restoring
 * exactly that kind of lost punch is reconcileStoreFromLedger's entire job.
 *
 * But PostgREST caps every REST response at 1000 rows however large the
 * `limit`, and the fetch was ordered ASCENDING with `.limit(5000)`. So the
 * server returned the OLDEST 1000 events in the 45-day window and dropped the
 * rest. Measured in production: 2045 ledger events, and the newest one
 * reconciliation ever RECEIVED was three weeks stale. Every punch after that
 * was invisible to it, so a lost Out was never restored — the store kept a
 * phantom-open shift, the screen kept showing "Clock Out", and
 * confirmClockState (which reads newest-first, 25 rows, under the cap) saw the
 * Out and refused the press as "you are already clocked out".
 *
 * The fix: order DESCENDING so the most recent activity is always covered, and
 * PAGE past the 1000-row cap with `.range()` so the whole window is walked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ledger = await readFile(new URL("../lib/ledger.ts", import.meta.url), "utf8");

const reconcile = ledger.slice(
  ledger.indexOf("export async function reconcileStoreFromLedger"),
  ledger.indexOf("export function markLogsRemoved"),
);
assert.ok(reconcile.length > 500, "reconcileStoreFromLedger could not be isolated");

test("reconciliation reads the ledger newest-first", () => {
  assert.match(reconcile, /\.order\("occurred_at", \{ ascending: false \}\)/);
  // The ascending single-shot fetch that got capped at the oldest 1000 is gone.
  assert.doesNotMatch(reconcile, /\.order\("occurred_at", \{ ascending: true \}\)\s*\n\s*\.limit\(5000\)/);
});

test("reconciliation pages past the 1000-row server cap", () => {
  // A loop over .range() windows, not one .limit() the server silently caps.
  assert.match(reconcile, /const RECONCILE_PAGE = 1000;/);
  assert.match(reconcile, /for \(let page = 0; page < RECONCILE_MAX_PAGES; page\+\+\) \{/);
  assert.match(reconcile, /\.range\(from, from \+ RECONCILE_PAGE - 1\)/);
  // It stops as soon as a short page proves the window is exhausted...
  assert.match(reconcile, /if \(pageRows\.length < RECONCILE_PAGE\) break;/);
  // ...and covers well beyond one cap's worth of events.
  assert.match(reconcile, /const RECONCILE_MAX_PAGES = 8;/);
});

test("a page error still fails safe, not silently empty", () => {
  // A mid-walk error keeps whatever was gathered; a first-page error aborts.
  assert.match(reconcile, /if \(error\) \{ if \(page === 0\) return \{ restored: 0 \}; break; \}/);
  // The restore loop still runs over the gathered rows, de-duped and removal-aware.
  assert.match(reconcile, /if \(!id \|\| present\.has\(id\) \|\| removed\.has\(id\)\) return;/);
});
