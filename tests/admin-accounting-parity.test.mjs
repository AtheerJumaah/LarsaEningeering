import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The owner asked for a promotable "Admin" role that can do essentially
 * everything the Super Admin can, except ever touching the single protected
 * Super Admin account itself. Org-chart admin control was covered separately
 * (see tests/org-admin-role.test.mjs, isOrgAdmin in lib/org.ts). This file
 * covers the other half the owner explicitly chose: full Accounting access,
 * implemented as Admin's own distinct, equally-full engine-facing role
 * rather than a reuse of "Owner / Super Admin".
 *
 * The client-side grant alone would be inert -- accounting.html/accounting-
 * cloud.js enforce nothing themselves, and every write ultimately runs
 * through Postgres SECURITY DEFINER RPCs that re-check the actor's role
 * server-side. The real behavioural proof that "Admin" is now recognized at
 * every one of those gates lives in tests/accounting-admin-role-sql.test.sql
 * (run via tests/run-sql-tests.sh against a real throwaway Postgres). This
 * file pins the client-side half: the exact pieces that build and transmit
 * that role string and permission profile in the first place.
 */

test("accountingRole gives Admin its own distinct role, ahead of the generic fallback", async () => {
  const page = await read("app/page.tsx");
  assert.match(
    page,
    /function accountingRole\(user: StaffUser\) \{\s*\n\s*if \(user\.access === "Super Admin"\) return "Owner \/ Super Admin";\s*\n\s*\/\*[\s\S]*?\*\/\s*\n\s*if \(user\.access === "Admin"\) return "Admin";\s*\n\s*if \(user\.access === "Manager"\) return "Management";/,
  );
});

test("ACCOUNTING_SECTIONS grants Admin the full section set, same construction as Super Admin", async () => {
  const page = await read("app/page.tsx");
  assert.match(
    page,
    /"Super Admin": new Set\(GROUPS\.find\(\(group\) => group\.label === "Accounting"\)!\.items\.map\(\(item\) => item\.section!\)\),\s*\n\s*\/\/[^\n]*\n\s*Admin: new Set\(GROUPS\.find\(\(group\) => group\.label === "Accounting"\)!\.items\.map\(\(item\) => item\.section!\)\),/,
  );
});

test("presetPermissionProfile grants Admin the full Accounting group, at the same ceiling Super Admin gets", async () => {
  const page = await read("app/page.tsx");
  const start = page.indexOf('} else if (preset === "Admin") {');
  const end = page.indexOf('} else if (preset === "Manager") {');
  assert.ok(start > -1 && end > start, "could not locate the Admin preset branch");
  const adminBranch = page.slice(start, end);
  // allowGroup with no restricted-actions argument grants every action
  // permissionActionsFor(item) allows for that item -- the same shape of
  // call the Super Admin branch makes for every group, per-group.
  assert.match(adminBranch, /allowGroup\("Accounting"\);/);
  // Guard against a future edit accidentally narrowing this to specific
  // actions (e.g. allowGroup("Accounting", ["view","export"])), which would
  // silently reintroduce the ceiling-vs-restricted gap this fix closes.
  assert.ok(
    !/allowGroup\("Accounting",\s*\[/.test(adminBranch),
    "Admin's Accounting grant must stay unrestricted (full ceiling), not narrowed to specific actions",
  );
});

test("isAdmin stays Super-Admin-only -- Admin's capability must flow through the permission profile, never this bypass", async () => {
  const page = await read("app/page.tsx");
  assert.match(
    page,
    /function isAdmin\(user: StaffUser\) \{\s*\n\s*return user\.access === "Super Admin";\s*\n\s*\}/,
  );
});

test("accounting-cloud.js: entryScopeOk mirrors the server's Admin bypass", async () => {
  const cloud = await read("public/engines/accounting-cloud.js");
  assert.match(
    cloud,
    /return accs\.indexOf\(me\) !== -1 \|\| emailList\(proj\.assigned_approvers\)\.indexOf\(me\) !== -1\s*\n\s*\|\| \(actor\(\) \|\| \{\}\)\.role === "Owner \/ Super Admin" \|\| \(actor\(\) \|\| \{\}\)\.role === "Admin";/,
  );
});

test("accounting-cloud.js: myPerm's pre-hydration fallback treats Admin like Owner / Super Admin / Management", async () => {
  const cloud = await read("public/engines/accounting-cloud.js");
  assert.match(
    cloud,
    /if \(\["Owner \/ Super Admin", "Management", "Admin"\]\.indexOf\(role\) !== -1\) return p !== "self_approve" && p !== "manage_permissions";/,
  );
});

test("accounting-cloud.js: WRITER_ROLES mirror stays in sync with the server's acct_writer_roles()", async () => {
  const cloud = await read("public/engines/accounting-cloud.js");
  assert.match(
    cloud,
    /var WRITER_ROLES = \["Owner \/ Super Admin", "Management", "Accountant", "Admin"\];/,
  );
});

test("accounting.html: v35AccountingRole labels a promoted Admin correctly instead of falling through to Engineer", async () => {
  const html = await read("public/engines/accounting.html");
  assert.match(
    html,
    /function v35AccountingRole\(access\)\{\s*\n\s*if\(access==="Super Admin"\) return "Owner \/ Super Admin";\s*\n\s*if\(access==="Admin"\) return "Admin";\s*\n\s*if\(access==="Manager"\) return "Management";/,
  );
});

test("the new Postgres migration gives Admin parity in all four role-string gates, without over-granting self_approve/manage_permissions", async () => {
  const sql = await read("supabase/migrations/20260806_acct_021_admin_role_parity.sql");
  // acct_role_default_perms: the load-bearing change.
  assert.match(sql, /when p_role in \('Owner \/ Super Admin','Management','Admin'\) then/);
  // The parity is deliberately not total: self_approve and manage_permissions
  // are individually-granted permissions that not even Owner / Super Admin
  // receives from role defaults, so the actual GRANTED array -- as opposed
  // to this file's prose explaining that omission -- must never include
  // them. Isolate the array literal itself so a legitimate comment mention
  // of the word (explaining why it's absent) can't trip this check.
  const grantMatch = sql.match(
    /when p_role in \('Owner \/ Super Admin','Management','Admin'\) then\s*\n\s*(array\[[\s\S]*?\])\s*\n/,
  );
  assert.ok(grantMatch, "could not isolate the Admin/Owner permission array literal");
  assert.ok(!/self_approve/.test(grantMatch[1]), "the granted array must not include self_approve");
  assert.ok(!/manage_permissions/.test(grantMatch[1]), "the granted array must not include manage_permissions");
  // acct_check_entry_scope: the hardcoded bypass.
  assert.match(
    sql,
    /coalesce\(actor->>'role',''\) = 'Owner \/ Super Admin'\s*\n\s*or coalesce\(actor->>'role',''\) = 'Admin' then/,
  );
  // acct_check_actor: the 'progress' branch's explicit role list.
  assert.match(
    sql,
    /array\['Owner \/ Super Admin','Management','Accountant','Admin','Project Manager','Construction Engineer'\]/,
  );
  // acct_writer_roles(): kept in sync even though dead, with its search_path
  // pin (added later by a separate ALTER in the original migration history)
  // carried forward explicitly rather than silently dropped by the replace.
  assert.match(
    sql,
    /create or replace function public\.acct_writer_roles\(\)\s*\nreturns text\[\]\s*\nlanguage sql immutable\s*\nset search_path = public, pg_temp\s*\nas \$\$ select array\['Owner \/ Super Admin','Management','Accountant','Admin'\] \$\$;/,
  );
});

test("the new SQL migration file is wired into the local throwaway-Postgres test runner", async () => {
  const runner = await read("tests/run-sql-tests.sh");
  assert.match(runner, /accounting-admin-role-sql\.test\.sql/);
});
