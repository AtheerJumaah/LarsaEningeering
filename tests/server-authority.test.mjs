import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const sync = await readFile(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");

test("shared company state restores sessions only after the authoritative roster is ready", () => {
  assert.match(page, /authoritativeStateReady/);
  assert.match(page, /Do not restore an employee identity from sessionStorage while an online/);
  assert.match(page, /let users = readStaffUsers\(\)/);
  assert.match(page, /const deadline = Date\.now\(\) \+ 7000/);
  assert.match(page, /while \(!users\.length && Date\.now\(\) < deadline\)/);
  assert.doesNotMatch(page, /Connecting securely…/);
  assert.doesNotMatch(page, /while \(currentConnection\(\) !== "online"/);
  assert.match(page, /Syncing your workspace…/);
});

test("engine navigation tolerates slow first paints without blocking the login thread", () => {
  assert.match(page, /maxAttempts = 100, intervalMs = 100/);
  assert.match(page, /if \(tries >= maxAttempts\)/);
});

test("optional verification calls have a bounded timeout", async () => {
  const verification = await readFile(new URL("../lib/verification.ts", import.meta.url), "utf8");
  assert.match(verification, /Promise\.race\(\[/);
  assert.match(verification, /const timeout = 4500/);
});

test("the performance store is included in shared server state", () => {
  assert.match(sync, /"larsaStaffGrowthV1"/);
});

test("a missing server staff roster never promotes an arbitrary browser cache", () => {
  assert.match(sync, /authoritative staff roster is missing on the server/);
  assert.match(sync, /if \(key === "larsaStaffV8"\)/);
  assert.match(sync, /originalSetItem\(key, "\{\}"\)/);
});

test("login is unblocked after the staff roster, without waiting for secondary stores", () => {
  assert.match(sync, /await pullKey\("larsaStaffV8"\);[\s\S]*options\.onStatusChange\?\.\("synced"\);[\s\S]*Promise\.all\(SYNCED_KEYS/);
});

test("the first punch waits for auth warm-up with a bounded fallback", () => {
  assert.match(page, /void warmAttendanceAuth\(\);/);
  assert.match(page, /Promise\.race\(\[[\s\S]*warmAttendanceAuth\(\),[\s\S]*1200/);
});
