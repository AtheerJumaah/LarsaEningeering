/* Larsa Control — the Accounting hard gate and the editor that opens it.
 *
 * Accounting is closed for every role and opened one person at a time —
 * accountingAccessAllowed() is checked BEFORE any stored grant, on purpose,
 * because old role presets baked accounting grants into saved profiles.
 *
 * The failure this file pins down: the Access editor let a Super Admin tick
 * a full page of accounting permissions, saved them durably into the
 * profile, and the person still saw nothing — the grants were dead switches
 * behind a gate the editor never opened and never mentioned. ("I gave
 * Yasser access to some accounting parts and he still doesn't have it.")
 *
 * The rule now: painting an accounting permission IS the act of letting the
 * person in, so an authorized editor ticking any accounting grant opens the
 * gate in the same draft — and if the gate is off while grants are ticked,
 * the switch panel says so instead of leaving two controls that quietly
 * disagree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("the hard gate itself is unchanged: checked first, opened per person", () => {
  assert.match(page, /function accountingAccessAllowed\(user: StaffUser\)/);
  assert.match(page, /return user\.accountingAccess === true;/);
  // Still checked before any stored grant, in the one shared permission check.
  assert.match(page, /if \(isAccountingItem\(item\) && !accountingAccessAllowed\(user\)\) return false;/);
});

test("ticking an accounting grant opens the gate in the same draft", () => {
  assert.match(page, /const opensAccountingGate = \(itemId: string, turnedOn: boolean\) => Boolean\(/);
  // Same predicate the save-side authority check uses for "accounting grants".
  assert.match(page, /\(itemId === "accounting-hub" \|\| itemId\.startsWith\("acc-"\)\)/);
  // Only an authorized editor opens it, never for roles that hold it anyway.
  assert.match(page, /draft\.access !== "Super Admin" && draft\.access !== "Accountant"/);
  assert.match(page, /currentUser\?\.platformAdmin === true \|\| currentUser\?\.access === "Super Admin"\),\s*\n\s*\);/);
  // All three grant-writing handlers couple through it.
  const couplings = page.match(/opensAccountingGate\(item\.id, checked\) \? \{ accountingAccess: true \}/g) || [];
  assert.equal(couplings.length, 2, "single-checkbox and whole-row handlers must couple the gate");
  assert.match(page, /const openGate = mode !== "clear" && group\.items\.some\(\(row\) => opensAccountingGate\(row\.id, true\)\);/);
  assert.match(page, /\.\.\.\(openGate \? \{ accountingAccess: true \} : \{\}\),/);
});

test("parked grants are said out loud, not left to be discovered", () => {
  assert.match(page, /they stay dark while this switch is off/);
});

test("the audit trail on the record is still written by the save", () => {
  assert.match(page, /accountingAccess: accountingNow \|\| undefined,/);
  assert.match(page, /accountingAccessAt: accountingNow === accountingWas/);
  assert.match(page, /accountingAccessBy: accountingNow === accountingWas/);
});
