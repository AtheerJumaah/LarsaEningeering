import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const sync = await readFile(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");

test("shared company state restores sessions only after the authoritative roster is ready", () => {
  assert.match(page, /authoritativeStateReady/);
  assert.match(page, /attendanceConnectionRef.current === "connecting"/);
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

test("every sign-in checks current policy without renewing local proof", () => {
  const signIn = page.slice(page.indexOf("const signIn = async"), page.indexOf("const signOut = useCallback"));
  assert.match(signIn, /await checkVerification\(user, loginMode\)/);
  assert.doesNotMatch(signIn, /locallyVerified|verified: true/);
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
  assert.match(sync, /await pullKey\("larsaStaffV8"\);[\s\S]*reportStatus\("synced"\);/);
  assert.match(sync, /refreshNowHook = \(\) => \{ void refreshFromServer\("login or explicit revalidation", \["larsaStaffV8"\]\); \};/);
  assert.match(sync, /const runSecondaryCatchup = async \(\) => \{/);
  assert.match(sync, /void runSecondaryCatchup\(\);/);
});

test("startup avoids downloading an unchanged roster blob", () => {
  assert.match(sync, /larsaSyncStampV1/);
  assert.match(sync, /larsaSyncHashV1/);
  assert.match(sync, /cachedHash === fingerprint\(baseline\)/);
  assert.match(sync, /select\("updated_at"\)/);
  assert.match(sync, /stamp-only startup check/);
  assert.match(sync, /const \{ data: row, error: selectError \} = await supabase[\s\S]*select\("data, updated_at"\)/);
});

test("healthy attendance probes do not replay the expensive synced handler", () => {
  assert.match(sync, /let lastReportedStatus:.*null = null/);
  assert.match(sync, /if \(lastReportedStatus === status\) return/);
  assert.match(sync, /const reportStatus = \(status/);
  assert.doesNotMatch(sync, /keys\.includes\("larsaStaffV8"\) options\.onStatusChange\?\.\("synced"\)/);
});

test("the first punch waits for auth warm-up with a bounded fallback", () => {
  assert.match(page, /void warmAttendanceAuth\(\);/);
  assert.match(page, /Promise\.race\(\[[\s\S]*warmAttendanceAuth\(\),[\s\S]*1200/);
});
