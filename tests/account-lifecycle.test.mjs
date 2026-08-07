import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The account lifecycle and identity rules from the incident repair:
 * ACTIVE and OFFBOARDED emails are reserved; the RECYCLING BIN frees an
 * email while preserving all history; restore is conflict-checked; permanent
 * deletion is Super-Admin-only; account ids can never collide again; and
 * re-onboarding offers the three history modes, none of which delete data. */

test("signup enforces the email identity rules: active reserved, offboarded reserved, recycled free", async () => {
  const access = await read("app/AccountAccess.tsx");
  assert.match(access, /An active account already exists with this email\./);
  assert.match(access, /An offboarded employee already exists with this email\./);
  // Recycled accounts do not reserve the address — both check sites skip them.
  const skips = access.match(/row\.recycled !== true/g) || [];
  assert.ok(skips.length >= 3, `expected recycled-aware guards, found ${skips.length}`);
  // And the rules are re-checked at the moment of the actual write (code stage).
  assert.match(access, /const emailConflict = list\.find\(\(row\) => normalise\(row\.email\) === address && row\.recycled !== true\);/);
});

test("account ids embed time + entropy so a rolled-back list can never reissue someone's id", async () => {
  const access = await read("app/AccountAccess.tsx");
  assert.match(access, /function nextUserId\(\) \{[\s\S]{0,40}return "u" \+ Date\.now\(\)\.toString\(36\) \+ Math\.floor\(Math\.random\(\) \* 1296\)/);
  assert.ok(!/highest = Math\.max\(highest, Number\(digits\)\);/.test(access), "the collision-prone max+1 series must be gone");
});

test("the lifecycle functions exist with the right gates and preservation guarantees", async () => {
  const page = await read("app/page.tsx");
  // Recycling Bin: soft delete, history kept, email freed.
  assert.match(page, /const recycleAccessUser = async \(target: StaffUser\)/);
  assert.match(page, /hasItemPermission\(actor, ACCESS_ITEM, "delete"\)[\s\S]{0,200}Recycling Bin/);
  assert.match(page, /recycled: true,\s*\n\s*offboarded: true,\s*\n\s*enabled: false,/);
  // Restore from bin is refused on an email conflict — nothing is overwritten.
  assert.match(page, /const restoreFromRecycleBin = async \(target: StaffUser\)/);
  assert.match(page, /row\.id !== target\.id && row\.recycled !== true && \(row\.email \|\| ""\)\.trim\(\)\.toLowerCase\(\) === email/);
  assert.match(page, /cannot be restored yet/);
  // Permanent delete: Super Admin only, protected owner excluded, history kept.
  assert.match(page, /const purgeAccessUser = async \(target: StaffUser\)/);
  assert.match(page, /actor\.access !== "Super Admin"[\s\S]{0,120}Only the Super Admin can permanently delete/);
  assert.match(page, /The protected owner account cannot be deleted\./);
  assert.match(page, /account\.permanent_delete/);
});

test("re-onboarding offers all three history modes and opens a new employment period", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const restoreAccessUser = async \(target: StaffUser, historyMode\?: "all" \| "current" \| "from", historyFrom\?: string\)/);
  assert.match(page, /periods\.push\(\{ start: nowIso \}\);/);
  assert.match(page, /account\.reactivated/);
  // The dialog presents exactly the three options.
  assert.match(page, /Include all previous history/);
  assert.match(page, /Current employment period only/);
  assert.match(page, /Include history from a date/);
  // History Mode is changeable later in the editor, and audited.
  assert.match(page, /account\.history_mode_changed/);
  assert.match(page, /<option value="all">All history<\/option>/);
});

test("history modes only filter display — the sessions builder drops nothing from storage", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /function historyStartFor\(user: StaffUser \| undefined\): number/);
  const builder = page.slice(page.indexOf("function buildClockSessions"), page.indexOf("function buildClockSessions") + 900);
  assert.match(builder, /if \(start && new Date\(log\.time\)\.getTime\(\) < start\) return;/);
  // No deletion primitives anywhere in the history-mode path.
  assert.ok(!/logs\.splice|store\.logs = \[\]/.test(page.slice(page.indexOf("function historyStartFor"), page.indexOf("function buildClockSessions"))));
});

test("controlled email change: identity history is recorded, never silently overwritten", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /prepared\.emailHistory = \[\s*\n\s*\.\.\.\(existing\.emailHistory \|\| \[\]\),\s*\n\s*\{ from: previousEmail, to: nextEmail, at: new Date\(\)\.toISOString\(\), by: actor\.name \},\s*\n\s*\];/);
  assert.match(page, /account\.email_changed/);
});

test("admins never see or set passwords/PINs for email accounts (self-service only)", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Passwords and PINs belong to the person, not the administrator/);
  assert.match(page, /New email-based accounts are created by the person themselves via Create Account/);
});
