/* Larsa Control — one press is enough.
 *
 * Engineers reported having to press the clock button MORE THAN ONCE before
 * it let them clock in or out. That was the refuse-then-press-again design:
 * when the app's view of the truth disagreed with the button, the first press
 * was refused with "press again if you really mean it". The refusal protected
 * against a stale screen writing a silent opposite punch — but it made the
 * person do the app's work.
 *
 * The contract now:
 *
 *   1. A press with an intent WRITES that intent. The written direction is
 *      `decided = intent ?? toggle(truth)` — with a button behind it, the
 *      record can only ever get what the button displayed. The silent
 *      opposite punch stays impossible by construction, with no refusal
 *      needed to prevent it.
 *   2. The ONLY press that does not write is one whose goal is already true
 *      ("clock out" when the record already shows Out). That is answered
 *      definitively with the state and its time — not bounced back with a
 *      "press again" chore — and a ledger reconcile is fired immediately so
 *      the store that mis-drew the button heals on the spot instead of on
 *      the next app load.
 *   3. The never-locked-out escape is absolute: a repeat of the same press
 *      inside two minutes bypasses even the duplicate answer and is written
 *      unconditionally. A wrong "truth" can cost at most one extra tap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

const punch = page.slice(
  page.indexOf("const punchClock = useCallback"),
  page.indexOf("const punchClockGuarded"),
);
assert.ok(punch.length > 500, "punchClock could not be isolated");

test("a press writes the direction the button offered — first time", () => {
  assert.match(punch, /const decided: "In" \| "Out" = intent \?\? \(trueStatus === "In" \? "Out" : "In"\);/);
  assert.match(punch, /status: decided,\s*\n\s*time: now, active: decided === "In"/);
  assert.match(punch, /notify\(decided === "In" \? `Clocked in · \$\{mode\}` : `Clocked out · \$\{mode\}`\);/);
  // The recomputed direction that used to be able to displace the intent is gone.
  assert.doesNotMatch(punch, /const status = trueStatus === "In" \? "Out" : "In";/);
});

test("nobody is told to press again to get what they asked for", () => {
  assert.doesNotMatch(punch, /Press again if you really are clocking/);
  assert.doesNotMatch(punch, /This screen was out of date and has been refreshed/);
  // The one remaining "press again" is the escape for a WRONG record — an
  // offer to overrule, not a step in the normal path.
  assert.match(punch, /If this is wrong, press again and it will be recorded anyway\./);
});

test("an already-true goal is answered and the record heals immediately", () => {
  assert.match(punch, /if \(trueStatus !== null && trueStatus === decided && !insisting\) \{/);
  assert.match(punch, /nothing to do\./);
  // Heal now, not on the next app load: the mis-drawn button proves the store
  // is missing a punch the ledger holds.
  assert.match(punch, /void reconcileStoreFromLedger\(\)\.then\(\(\{ restored \}\) => \{/);
  assert.match(punch, /\}\)\.catch\(\(\) => \{ \/\* the next sync retries \*\/ \}\);/);
});

test("the insist escape bypasses even the duplicate answer", () => {
  // `&& !insisting` on the only non-writing branch: an insisted repeat writes.
  const answer = punch.indexOf("trueStatus === decided && !insisting");
  assert.ok(answer > 0, "the duplicate answer must be conditional on not insisting");
  assert.match(punch, /const insisting = Boolean\(intent\) && serverNowMs\(\) - \(clockRefusals\.current\[refusalKey\] \|\| 0\) < 120_000;/);
  assert.match(punch, /delete clockRefusals\.current\[refusalKey\];/);
});
