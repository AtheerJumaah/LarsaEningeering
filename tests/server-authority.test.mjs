import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const sync = await readFile(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");

test("shared company state waits for the authoritative server roster before restoring a session", () => {
  assert.match(page, /authoritativeStateReady/);
  assert.match(page, /Do not restore an employee identity from sessionStorage while an online/);
  assert.match(page, /Company data is still syncing\. Please wait a moment/);
  assert.match(page, /Syncing your workspace…/);
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
