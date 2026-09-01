/* Larsa Control — the clock must always let a person clock.
 *
 * The guard that stopped silent wrong punches started refusing real ones:
 * "You are already clocked in", forever, for people who were not clocked in.
 * Two causes, one principle.
 *
 * CAUSE 1 — the ledger never forgets, but managers do delete.
 * `attendance_events` is append-only by design. When a manager resets or
 * removes a session, the punches leave the staff document and their ids go
 * into `removedLogIds` — but they stay in the ledger for ever. Reconciliation
 * always knew this and skipped removed ids when restoring. `confirmClockState`
 * did not, so it kept answering with a punch that no longer existed: the
 * person was "already clocked in" according to a record nobody could see, and
 * every press was refused. Production carried 359 removed ids when this was
 * written, so the exposed population was real.
 *
 * CAUSE 2 — the tie-break compared text, not time.
 * Postgres renders a timestamptz as "…T15:58:00+00:00"; the browser writes
 * "…T15:58:00.000Z". Compared as strings, "." beats "+", so a local queued
 * copy could win a tie it should have lost.
 *
 * THE PRINCIPLE — refuse once, never twice.
 * Guessing wrong in the refusing direction is not "safe": a person who cannot
 * clock in loses wages and cannot fix it themselves, while a duplicate punch
 * is visible and can be trimmed. So the first contradicting press is still
 * held back, named and refreshed — that is what stops a stale screen writing a
 * silent opposite punch — but a second press of the SAME direction, made after
 * seeing what the record says, is honoured against the staff document. No data
 * conflict, and no future bug of this class, can lock somebody out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const ledger = await readFile(new URL("../lib/ledger.ts", import.meta.url), "utf8");

const punch = page.slice(
  page.indexOf("const punchClock = useCallback"),
  page.indexOf("const punchBreak = useCallback"),
);
const breakBody = page.slice(
  page.indexOf("const punchBreak = useCallback"),
  page.indexOf("holder.__larsaBreak ="),
);
assert.ok(punch.length > 500 && breakBody.length > 500, "the two writers could not be isolated");

test("a punch a manager deleted can never answer for the person again", () => {
  // The removed list is a parameter, not an afterthought.
  assert.match(ledger, /removedIds: readonly string\[\] = \[\],/);
  assert.match(ledger, /const removed = new Set\(removedIds\.map\(String\)\);/);
  // Applied to the server's answer...
  assert.match(ledger, /\.select\("client_event_id, status, occurred_at"\)/);
  assert.match(ledger, /const row = rows\.find\(\(candidate\) => !removed\.has\(String\(candidate\?\.client_event_id \|\| ""\)\)\) \|\| null;/);
  // ...and to anything still queued on this device.
  assert.match(ledger, /&& !removed\.has\(String\(event\.client_event_id \|\| ""\)\)\)/);
  // Enough rows that a run of deleted ones cannot hide the surviving answer.
  assert.match(ledger, /\.limit\(25\)/);
});

test("both callers actually hand the removed list over", () => {
  assert.match(punch, /const confirmed = await confirmClockState\(user\.id, preStore\?\.removedLogIds \|\| \[\]\);/);
  assert.match(breakBody, /const confirmed = await confirmClockState\(user\.id, store\.removedLogIds \|\| \[\]\);/);
  /* The store is read once for the removed list, then re-read after the await
     so the copy that is modified and written back is the freshest one. */
  assert.match(punch, /const preStore = parseStore\("larsaStaffV8"\) as \{ removedLogIds\?: string\[\] \} \| null;/);
  const preAt = punch.indexOf("const preStore =");
  const reAt = punch.indexOf('const store = parseStore("larsaStaffV8");');
  assert.ok(preAt > 0 && reAt > preAt, "the store must be re-read after the confirm");
});

test("times are compared as instants, never as text", () => {
  assert.match(ledger, /const ms = \(value: unknown\) => \{/);
  assert.match(ledger, /const at = Date\.parse\(String\(value \|\| ""\)\);/);
  assert.match(ledger, /\.sort\(\(left, right\) => ms\(right\.occurred_at\) - ms\(left\.occurred_at\)\)\[0\] \|\| null;/);
  assert.match(ledger, /if \(queued\?\.occurred_at && ms\(queued\.occurred_at\) > ms\(at\)\) \{/);
  // The old string comparisons are gone for good.
  assert.doesNotMatch(ledger, /String\(queued\.occurred_at\) > at/);
  assert.doesNotMatch(ledger, /localeCompare\(String\(left\.occurred_at\)\)/);
});

test("the first contradicting press is still refused, and says so", () => {
  assert.match(punch, /if \(intent && intent !== status\) \{/);
  assert.match(punch, /clockRefusals\.current\[refusalKey\] = serverNowMs\(\);/);
  assert.match(punch, /nothing was changed\. This screen was out of date and has been refreshed\./);
  // It tells the person what to do next instead of leaving them stuck.
  assert.match(punch, /Press again if you really are clocking \$\{intent === "In" \? "in" : "out"\}\./);
  const refuseAt = punch.indexOf("if (intent && intent !== status)");
  assert.ok(refuseAt > 0 && refuseAt < punch.indexOf("store.logs.push("),
    "the refusal must still run before anything is appended");
});

test("the second press of the same direction is always honoured", () => {
  assert.match(page, /const clockRefusals = useRef<Record<string, number>>\(\{\}\);/);
  assert.match(page, /const breakRefusals = useRef<Record<string, number>>\(\{\}\);/);
  // Keyed per person AND per direction: overriding takes deliberately
  // repeating the rejected press, not just any second tap.
  assert.match(punch, /const refusalKey = `\$\{user\.id\}:\$\{intent \|\| ""\}`;/);
  assert.match(punch, /const insisting = Boolean\(intent\) && serverNowMs\(\) - \(clockRefusals\.current\[refusalKey\] \|\| 0\) < 120_000;/);
  // On insistence the staff document decides, so every other guard still runs.
  assert.match(punch, /const ledgerWins = !insisting && confirmed\.reached/);
  // And the offer is spent once used.
  assert.match(punch, /delete clockRefusals\.current\[refusalKey\];/);
});

test("breaks get the same guarantee", () => {
  assert.match(breakBody, /const breakKey = `\$\{user\.id\}:\$\{intent \|\| ""\}`;/);
  assert.match(breakBody, /const breakInsisting = Boolean\(intent\) && serverNowMs\(\) - \(breakRefusals\.current\[breakKey\] \|\| 0\) < 120_000;/);
  assert.match(breakBody, /if \(intent && intent !== offering && !breakInsisting\) \{/);
  // "Clock in first" is a refusal too, so it must also be escapable.
  assert.match(breakBody, /const onShift = !breakInsisting && confirmed\.reached/);
  assert.match(breakBody, /breakRefusals\.current\[breakKey\] = serverNowMs\(\);/);
});
