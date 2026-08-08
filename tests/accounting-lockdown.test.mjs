import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* Accounting is closed to every role.
 *
 * The rule the company asked for: nobody sees anything from Accounting except
 * the Developer, a Super Admin, an Accountant, and whoever one of those has
 * deliberately let in. Everyone else gets My Pay — their own salary record —
 * and nothing else financial.
 *
 * The first two tests below run the real gate functions, lifted out of the
 * page source and evaluated, so they check behaviour rather than wording. The
 * rest check that the gate is actually wired into the one place every screen,
 * tile, sidebar entry and navigation asks for permission. */

const page = await read("app/page.tsx");

/* Lift the two pure gate functions out of the page and run them for real. If
 * either is renamed or deleted this throws, which is the point. */
function loadGate() {
  const grab = (name) => {
    const start = page.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    let depth = 0;
    let index = page.indexOf("{", start);
    const open = index;
    for (; index < page.length; index += 1) {
      if (page[index] === "{") depth += 1;
      else if (page[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return page.slice(start, index + 1).replace(/: \w+(\[\])?(?=[),])/g, "");
  };
  const openSet = page.match(/const ACCOUNTING_ALWAYS_OPEN = new Set\(\[[^\]]*\]\);/);
  assert.ok(openSet, "ACCOUNTING_ALWAYS_OPEN must exist");
  const source = `
    ${openSet[0]}
    ${grab("isAccountingItem")}
    ${grab("accountingAccessAllowed")}
    return { isAccountingItem, accountingAccessAllowed };
  `;
  return new Function(source)();
}

const { isAccountingItem, accountingAccessAllowed } = loadGate();

test("only the Developer, Super Admins, Accountants and the deliberately-granted are let in", () => {
  // Allowed.
  assert.equal(accountingAccessAllowed({ platformAdmin: true, access: "Engineer" }), true, "the Developer");
  assert.equal(accountingAccessAllowed({ access: "Super Admin" }), true, "a Super Admin");
  assert.equal(accountingAccessAllowed({ access: "Accountant" }), true, "an Accountant");
  assert.equal(accountingAccessAllowed({ access: "Engineer", accountingAccess: true }), true, "granted per person");

  /* Refused — every other role, including the ones whose presets used to hand
   * out accounting grants, and including Admin, who ranks above Manager but
   * still has no business in the ledgers unless somebody says so. */
  for (const access of [
    "Admin", "Manager", "Admin HR", "Team Leader", "Construction Engineer",
    "Engineer", "Trainee", "Intern", "Viewer", "Client", "", undefined,
  ]) {
    assert.equal(accountingAccessAllowed({ access }), false, `${access || "(no role)"} must be refused`);
  }
  // A stored flag that is anything other than true is not a grant.
  assert.equal(accountingAccessAllowed({ access: "Engineer", accountingAccess: "yes" }), false);
  assert.equal(accountingAccessAllowed({ access: "Engineer", accountingAccess: false }), false);
});

test("every financial screen counts as Accounting; My Pay and Assigned Projects do not", () => {
  // The whole accounting engine, whatever section it is.
  for (const id of [
    "acc-dashboard", "acc-master", "acc-funding", "acc-iq-revenue", "acc-us-operating",
    "acc-usa-ledger", "acc-iraq-ledger", "acc-expenses", "acc-materials", "acc-labor",
    "acc-payroll", "acc-commissions", "acc-clients", "acc-projects", "acc-boq",
    "acc-refs", "acc-employees", "acc-reports", "acc-review", "acc-notifications",
    "acc-settings",
  ]) {
    assert.equal(isAccountingItem({ id, engine: "accounting" }), true, `${id} must be gated`);
  }
  // And the screens that reach the same money by another door.
  assert.equal(isAccountingItem({ id: "accounting-hub" }), true, "the hub itself");
  assert.equal(isAccountingItem({ id: "payroll-portal" }), true, "everybody's payslips");
  assert.equal(isAccountingItem({ id: "sales-commissions" }), true, "everybody's commissions");
  assert.equal(isAccountingItem({ id: "construction-financials" }), true, "project cost and profit");

  /* Deliberately still open: an employee's own pay, and the project workspace
   * engineers work in — which is filed under Accounting in the navigation but
   * carries no financial figures of its own. */
  assert.equal(isAccountingItem({ id: "my-pay" }), false, "My Pay stays open to everyone");
  assert.equal(isAccountingItem({ id: "project-portal" }), false, "Assigned Projects stays open");
  // Nothing outside accounting is caught by accident.
  assert.equal(isAccountingItem({ id: "quick-clock", engine: "staff" }), false);
  assert.equal(isAccountingItem({ id: "hr-dashboard", engine: "hr" }), false);
});

test("the gate is checked before any stored permission, in the one place everything asks", () => {
  /* It sits at the top of hasItemPermission — ahead of the grant lookup and
   * ahead of the legacy role fallback — so neither the accounting grants that
   * old role presets baked into saved profiles nor ACCOUNTING_SECTIONS can let
   * anybody back in. That is also why no stored record had to be edited. */
  assert.match(page, /function hasItemPermission\(user: StaffUser, item: Item, action: PermissionAction = "view"\): boolean \{\s*\n\s*if \(isAdmin\(user\)\) return true;[\s\S]{0,900}?if \(isAccountingItem\(item\) && !accountingAccessAllowed\(user\)\) return false;/);
  // Every route in — sidebar, tiles, hub, quick actions, notifications — goes
  // through canOpen → hasItemPermission, and navigation refuses on its own.
  assert.match(page, /function canOpen\(user: StaffUser \| null, item: Item\) \{[\s\S]*?return hasItemPermission\(user, item, "view"\);/);
  assert.match(page, /if \(!canOpenInSession\(sessionUserRef\.current, item, sessionMethodRef\.current\)\) \{\s*\n\s*notify\("You do not have access to this area\."\);/);
});

test("the embedded accounting engine is handed a closed matrix, not an empty one", () => {
  /* An empty object means "no override" and lets the engine apply its own
   * role defaults — which is exactly how a profile-less Engineer would have
   * kept seeing sections. Denied accounts fall through to the loop instead,
   * and every lookup in it goes through the refusing hasItemPermission. */
  assert.match(page, /const denied = !accountingAccessAllowed\(user\);\s*\n\s*if \(!denied && !user\.permissionProfile\) return \{\};/);
  assert.match(page, /result\.settings\.manageUsers = !denied && hasItemPermission\(user, ACCESS_ITEM, "manage"\);/);
});

test("only the Developer or a Super Admin can open the door, and it is audited", async () => {
  // Client side: the switch itself is refused for anyone below Super Admin.
  assert.match(page, /const accountingWas = existingRecord\?\.accountingAccess === true;/);
  assert.match(page, /const accountingNow = nextUser\.accountingAccess === true;/);
  assert.match(page, /if \(!actorIsDeveloper && !actorIsSuperAdmin\s*\n\s*&& \(accountingGrantsOf\(existingRecord\?\.permissionProfile\) !== accountingGrantsOf\(nextUser\.permissionProfile\)\s*\n\s*\|\| accountingWas !== accountingNow\)\) \{\s*\n\s*notify\("Only the Developer or a Super Admin can change Accounting access\."\);/);
  // And in the editor the control is locked for everyone else.
  assert.match(page, /const canGrantAccounting = currentUser\?\.platformAdmin === true \|\| currentUser\?\.access === "Super Admin";/);
  assert.match(page, /disabled=\{!canGrantAccounting \|\| accountingByRole\}/);
  // Every opening and closing is recorded with who did it and both values.
  assert.match(page, /logAccountEvent\(actor, "account\.accounting_access_changed", existing\.id, existing\.name, \{\s*\n\s*from: accountingWas, to: accountingNow,\s*\n\s*\}\);/);

  /* Defence in depth: the financial permissions themselves are enforced by
   * Postgres, which demands the platform owner plus a freshly emailed code —
   * so a forged payload cannot grant accounting even with this file patched. */
  const migration = await read("supabase/migrations/20260802_acct_006_review_receipts_permissions.sql");
  assert.match(migration, /if not public\.acct_is_platform_admin\(a_email\) then/);
  assert.match(migration, /acct_consume_email_code\(a_email, p_code\)/);
});

test("My Pay is still reachable by everyone, with no accounting grant involved", () => {
  // Personal, like My Settings: unconditional here, scoped to the signed-in
  // person by the server.
  assert.match(page, /if \(item\.id === "my-pay"\) return true;/);
  // It is a Home screen, so closing Accounting cannot strand it in a hidden
  // channel, and the PIN sign-in keeps it too.
  assert.match(page, /if \(item\.id === "my-settings" \|\| item\.id === "my-pay"\) return "home";/);
  assert.match(page, /PIN_ALLOWED_ITEMS = new Set\(\[[^\]]*"my-pay"[^\]]*\]\)/);
});
