/* Larsa Control — Users & Access, in a real browser.
 *
 * The contract tests (tests/viewer-accounts.test.mjs) read the source; this
 * one drives the actual rendered admin UI, because "three tabs" and "no
 * password field on a pending request" are claims about a browser, not
 * about a string. Runs WITHOUT Supabase configured on purpose — the Viewer
 * Accounts tab's degraded (no-backend) path is exactly the one nobody
 * exercises by hand.
 *
 *   node tests/viewer-accounts-e2e.smoke.mjs            # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";

const ADMIN = {
  id: "u-admin", name: "Atheer Admin", email: "admin@larsaeng.com",
  role: "Super Admin", access: "Super Admin", enabled: true, active: true,
};
// A self-registered signup still waiting on approval: exactly the shape
// Create Account produces — Engineer requested, disabled until decided,
// and (as a real registration would) an already-set password/PIN that the
// admin must never be shown.
const PENDING = {
  id: "u-pending", name: "Nora Hassan", email: "nora@larsaeng.com",
  role: "Engineer", access: "Engineer", department: "Engineering",
  enabled: false, active: false, pendingApproval: true,
  password: "$2b$hashed-placeholder", pin: "$2b$hashed-placeholder",
};

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.addInitScript(({ admin, pending }) => {
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [admin, pending] }));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: admin, method: "email" }));
}, { admin: ADMIN, pending: PENDING });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(3000);

// ------------------------------------------------------------- navigate in
// Home -> Administration -> Users & Access, the same two clicks a Super
// Admin actually makes; nothing here is a direct deep link.
const adminCard = page.locator(".native.active .module-grid .module-bubble", { hasText: "Administration" });
check("the Administration card is on Home", await adminCard.count() === 1);
await adminCard.click();
await page.waitForTimeout(700);

const accessCard = page.locator(".native.active .module-grid .module-bubble", { hasText: "Users & Access" });
check("Users & Access is offered from Admin Center", await accessCard.count() === 1);
await accessCard.click();
await page.waitForTimeout(700);

const heading = await page.locator(".native.active .access-hero h2").textContent().catch(() => "");
check("landed on the Users & Access screen", heading === "Users & Access", heading);

// ------------------------------------------------------------------- tabs
const tabButtons = page.locator(".native.active .scope-switch-track button");
const tabLabels = await tabButtons.allTextContents();
check("there are exactly three tabs", tabLabels.length === 3, JSON.stringify(tabLabels));
check("Pending Requests carries the waiting count", tabLabels[0] === "Pending Requests (1)", tabLabels[0]);
check("Active Users is named plainly", tabLabels[1] === "Active Users", tabLabels[1]);
check("Viewer Accounts is its own tab, not folded into the others", tabLabels[2] === "Viewer Accounts", tabLabels[2]);
check("Active Users is the tab a visit starts on",
  (await tabButtons.nth(1).getAttribute("aria-pressed")) === "true");

// --------------------------------------------------------- Active Users
const activeHead = await page.locator(".native.active .access-directory-head h3").textContent().catch(() => "");
check("Active Users shows only decided accounts", activeHead === "1 active", activeHead);
const activeNames = await page.locator(".native.active .access-user-list .access-user b").allTextContents();
check("the pending signup is not in Active Users", !activeNames.includes("Nora Hassan"), JSON.stringify(activeNames));
check("New User is offered on Active Users",
  await page.locator(".native.active .access-directory-head button", { hasText: "New User" }).count() === 1);

// -------------------------------------------------------- Pending Requests
await tabButtons.nth(0).click();
await page.waitForTimeout(500);
const pendingHead = await page.locator(".native.active .access-directory-head h3").textContent().catch(() => "");
check("Pending Requests shows only the waiting signup", pendingHead === "1 pending", pendingHead);
check("New User is not offered on Pending Requests — approval is the only path in",
  await page.locator(".native.active .access-directory-head button", { hasText: "New User" }).count() === 0);

await page.locator(".native.active .access-user-list .access-user", { hasText: "Nora Hassan" }).click();
await page.waitForTimeout(500);
const pendingPanel = await page.evaluate(() => {
  const editor = document.querySelector(".native.active .access-editor");
  if (!editor) return null;
  const text = editor.textContent || "";
  return {
    hasApprove: [...editor.querySelectorAll("button")].some((b) => b.textContent.trim() === "Approve"),
    hasReject: [...editor.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reject"),
    passwordFields: editor.querySelectorAll('input[type="password"]').length,
    // The username-only PIN input carries this exact label; Nora is an
    // Engineer (email-based), so it must not be present either.
    pinLabelPresent: /Employee PIN/.test(text),
    saysNeverShown: /Password and PIN are never shown or set here/.test(text),
  };
});
check("a pending request offers Approve", pendingPanel?.hasApprove === true, JSON.stringify(pendingPanel));
check("and Reject", pendingPanel?.hasReject === true);
check("with zero password fields rendered", pendingPanel?.passwordFields === 0);
check("and no PIN field either", pendingPanel?.pinLabelPresent === false);
check("the editor says outright that the password/PIN are never shown here", pendingPanel?.saysNeverShown === true);

// -------------------------------------------------- back to Active Users
await tabButtons.nth(1).click();
await page.waitForTimeout(500);
const activeAgain = await page.locator(".native.active .access-user-list .access-user b").allTextContents();
check("switching back to Active Users still excludes the pending signup",
  activeAgain.length === 1 && activeAgain[0] === "Atheer Admin", JSON.stringify(activeAgain));

// ------------------------------------------------------------ Viewer Accounts
await tabButtons.nth(2).click();
await page.waitForTimeout(500);
const viewerPanel = await page.evaluate(() => {
  const root = document.querySelector(".native.active .access-layout");
  if (!root) return null;
  const text = root.textContent || "";
  return {
    directoryCount: (root.querySelector(".access-directory-head h3") || {}).textContent,
    hasCreateButton: [...root.querySelectorAll(".access-directory-head button")]
      .some((b) => /Create Viewer Account/.test(b.textContent || "")),
    explainsNoEmail: /No email, no email verification, no company password reset/.test(text),
    emptyState: /No Viewer accounts yet\./.test(text),
    // The Pending/Active editor (password org-note, Approve/Reject) must not
    // still be mounted underneath — this is a different panel, not an overlay.
    leaksStaffEditor: /Password and PIN are never shown or set here/.test(text) || /Approve/.test(text),
  };
});
check("the Viewer Accounts tab renders its own directory", Boolean(viewerPanel), JSON.stringify(viewerPanel));
check("with a Create Viewer Account action", viewerPanel?.hasCreateButton === true);
check("that explains Viewers need no email at all", viewerPanel?.explainsNoEmail === true);
check("and shows the empty state with no backend configured", viewerPanel?.emptyState === true);
check("without leaking the staff editor underneath", viewerPanel?.leaksStaffEditor === false);

await browser.close();

/* Signing in through the minimal larsaStaffV8 fixture (as every *.smoke.mjs
   in this repo does) leaves engines/timeclock.html without the shift/roster
   seed data it expects on load, and it throws while migrating its own
   local state — nothing to do with Users & Access or Viewer accounts.
   tests/my-pay-e2e.smoke.mjs hit this exact pair of messages first and
   already carries this same exclusion; matched here rather than re-litigated. */
const fatal = pageErrors.filter((e) => !/Failed to fetch|forEach|setting '/.test(e));
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.map((f) => f.label),
  pageErrors: fatal,
}, null, 1));
process.exit(failed.length || fatal.length ? 1 : 0);
