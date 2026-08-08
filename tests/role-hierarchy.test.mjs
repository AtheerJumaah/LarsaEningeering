import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The role hierarchy — Developer → Super Admin → Admin → everyone — plus the
 * realtime/identity corrections from the clock & access-control audit. */

test("only the Developer manages Super Admins; only Developer/Super Admin manage Admins", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const actorIsDeveloper = actor\.platformAdmin === true;/);
  assert.match(page, /Only the Developer can create or remove Super Admins\./);
  assert.match(page, /Only the Developer or a Super Admin can grant or remove the Admin role\./);
  // The Super Admin option is only selectable for the Developer.
  assert.match(page, /disabled=\{role === "Super Admin" && !protectedAccount && currentUser\?\.platformAdmin !== true\}/);
});

test("nobody can change their own role", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /actor\.id === existingRecord\.id\s*\n\s*&& previousAccess !== nextAccess && previousAccess !== "Super Admin"/);
  assert.match(page, /You cannot change your own role\./);
});

test("Admins cannot touch Accounting access — and the financial backend enforces it independently", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Only the Developer or a Super Admin can change Accounting access\./);
  assert.match(page, /itemId === "accounting-hub" \|\| itemId\.startsWith\("acc-"\)/);
  // Server side: acct_set_permissions demands the platform owner + a fresh
  // emailed code, so a forged payload cannot grant accounting either.
  const migration = await read("supabase/migrations/20260802_acct_006_review_receipts_permissions.sql");
  assert.match(migration, /if not public\.acct_is_platform_admin\(a_email\) then/);
  assert.match(migration, /only a Platform Super Admin may configure accounting permissions/);
  assert.match(migration, /acct_consume_email_code\(a_email, p_code\)/);
});

test("the Developer's protection is keyed to identity, not the display name", async () => {
  const page = await read("app/page.tsx");
  // The client resolves developer status from the server (platform_admins by
  // email), never from a name string; and the owner row keeps its
  // trigger-forced Super Admin state.
  assert.match(page, /op: "amPlatformAdmin", email: u\.email/);
  assert.match(page, /if \(existing\.access === "Super Admin"\) \{\s*\n\s*prepared\.access = "Super Admin";/);
  assert.ok(!/actor\.name === "Atheer Jumaah"|name === "Atheer"/.test(page), "no name-string protection allowed");
});

test("every role change is audited with actor, target, old and new values", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /logAccountEvent\(actor, "account\.role_changed", existing\.id, existing\.name, \{\s*\n\s*from: existing\.access \|\| "\(none\)", to: prepared\.access \|\| "\(none\)",\s*\n\s*\}\);/);
});

test("recovered sessions never masquerade as employees named uNN", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /Needs identification \(recovered session, was \$\{uid\}\)/);
  assert.match(page, /Former staff \(\$\{uid\}\)/);
  assert.match(page, /const needsReview = rows\.some\(\(row\) => row\.recovery === "needs-review"\);/);
});

test("punches persist immediately — no debounce between the press and the backend write", async () => {
  const page = await read("app/page.tsx");
  const pushes = page.match(/pushSyncedKeyNow\("larsaStaffV8"\);/g) || [];
  assert.ok(pushes.length >= 3, `punch, break, and manual-entry paths must all push now (found ${pushes.length})`);
  const sync = await read("lib/supabase/sync.ts");
  assert.match(sync, /export function pushSyncedKeyNow\(key: SyncedKey\)/);
});

test("the app revalidates authoritative state on focus, reconnect, and realtime resubscribe", async () => {
  const sync = await read("lib/supabase/sync.ts");
  assert.match(sync, /async function refreshFromServer\(reason: string\)/);
  assert.match(sync, /document\.addEventListener\("visibilitychange", onVisible\);/);
  assert.match(sync, /window\.addEventListener\("online", onOnline\);/);
  assert.match(sync, /if \(status === "SUBSCRIBED" && hadChannelDrop\) \{/);
  // Missed-event safety: resubscribe re-fetches instead of assuming silence.
  assert.match(sync, /refreshFromServer\("realtime resubscribed"\)/);
  // And the timer never depends on a fragile counter — it derives from the
  // persisted clock-in timestamp, so refresh/restart/resume reconstructs it.
  const page = await read("app/page.tsx");
  assert.match(page, /now\.getTime\(\) - new Date\(open\.clockIn\)\.getTime\(\)/);
});
