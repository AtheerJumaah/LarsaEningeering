import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The Super Admin account is a permanently locked singleton (see
 * tests/viewer-accounts.test.mjs and the account-deletion/role-dropdown
 * guards in app/page.tsx) -- nobody can create a second one. What the owner
 * asked for instead is a promotable "Admin" role that can do everything an
 * Admin should except ever touching that protected account. This file pins
 * the org-chart half of that: isOrgAdmin now recognizes both account types,
 * so a promoted Admin gets full department/team control the same as the
 * Super Admin, without becoming a second protected owner.
 */

test("isOrgAdmin grants full org-chart control to both Super Admin and Admin, nobody else", async () => {
  const org = await read("lib/org.ts");
  assert.match(
    org,
    /export function isOrgAdmin\(user: OrgUser \| null \| undefined\): boolean \{\s*\n\s*return Boolean\(user && \(user\.access === "Super Admin" \|\| user\.access === "Admin"\)\);\s*\n\s*\}/,
  );
});

test("rolesOf tells a promoted Admin apart from the actual Super Admin", async () => {
  const org = await read("lib/org.ts");
  const fn = org.slice(org.indexOf("export function rolesOf"), org.indexOf("export function rolesOf") + 400);
  assert.match(fn, /if \(user\.access === "Super Admin"\) roles\.push\("Super Admin"\);/);
  assert.match(fn, /else if \(isOrgAdmin\(user\)\) roles\.push\("Org Admin"\);/);
});

test("every org-chart admin gate in OrgStructure and the Engineering Dashboard still routes through isOrgAdmin", async () => {
  // Nothing here should have started checking user.access === "Super Admin"
  // directly -- that would silently exclude promoted Admins from a spot
  // isOrgAdmin itself already covers.
  const structure = await read("app/OrgStructure.tsx");
  const hier = await read("app/HierarchyDashboard.tsx");
  assert.ok(!/access === "Super Admin"/.test(structure), "OrgStructure must gate through isOrgAdmin(), not a literal access check");
  assert.ok(!/access === "Super Admin"/.test(hier), "HierarchyDashboard must gate through isOrgAdmin(), not a literal access check");
  const structureAdminChecks = structure.match(/isOrgAdmin\(viewer\)/g) || [];
  assert.ok(structureAdminChecks.length >= 5, `expected department/team admin controls to still gate on isOrgAdmin (found ${structureAdminChecks.length})`);
  assert.match(hier, /isOrgAdmin\(viewer\)\) org\.departments\.forEach/);
});
