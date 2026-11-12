import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { needsLongHoursConfirmation } from "../lib/attendance.mjs";

const started = "2026-11-10T08:00:00.000Z";
const after = (hours, seconds = 0) => new Date(Date.parse(started) + hours * 3600000 + seconds * 1000).toISOString();

test("only a completed shift strictly beyond ten hours asks for confirmation", () => {
  assert.equal(needsLongHoursConfirmation(started, after(9, 59 * 60)), false);
  assert.equal(needsLongHoursConfirmation(started, after(10)), false);
  assert.equal(needsLongHoursConfirmation(started, after(10, 1)), true);
  assert.equal(needsLongHoursConfirmation(started, after(16)), true);
  assert.equal(needsLongHoursConfirmation("invalid", after(11)), false);
});

test("long-shift confirmation is independent of the clock action and gated by policy", async () => {
  const [page, settings, policy] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/PlatformSettings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/auth-policy/index.ts", import.meta.url), "utf8"),
  ]);
  const confirmation = page.slice(page.indexOf("const confirmLongSession = useCallback"), page.indexOf("Removes a session outright"));
  assert.match(confirmation, /policy\.long_hours_requires_approval === true/);
  assert.match(confirmation, /reviewOnly: !requiresApproval/);
  assert.match(confirmation, /outLog\.longHoursStatus = requiresApproval \? "pending" : "confirmed"/);
  assert.match(page, /Confirm hours/);
  assert.match(page, /Trim instead/);
  assert.match(settings, /long_hours_requires_approval: policy\.attendance_approval\?\.long_hours_requires_approval === true/);
  assert.match(policy, /long_hours_requires_approval: false/);
});
