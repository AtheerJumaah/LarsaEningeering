// Browser-level Organization Chart exercise with an isolated company document.
// Every Supabase request is intercepted; the test cannot alter production data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
const admin = { id: "admin", name: "Admin Owner", email: "admin@example.invalid", enabled: true, access: "Super Admin", role: "Managing Director" };
const coo = { id: "coo", name: "Casey Operations", email: "coo@example.invalid", enabled: true, access: "Employee", role: "Chief Operating Officer", department: "Management" };
const architect = { id: "architect", name: "Alex Architect", email: "architect@example.invalid", enabled: true, access: "Employee", role: "Architecture Department Head", department: "Architecture" };
const engineer = { id: "engineer", name: "Erin Engineer", email: "engineer@example.invalid", enabled: true, access: "Employee", role: "Architect", department: "Architecture" };
let staff = {
  users: [admin, coo, architect, engineer],
  logs: [],
  org: {
    departments: [
      { id: "dep-management", name: "Management", headIds: [admin.id] },
      { id: "dep-architecture", name: "Architecture", headIds: [architect.id] },
    ],
    teams: [
      { id: "team-operations", departmentId: "dep-management", name: "Operations", leadIds: [admin.id], memberIds: [coo.id] },
      { id: "team-architecture", departmentId: "dep-architecture", name: "Architecture A", leadIds: [architect.id], memberIds: [architect.id, coo.id, engineer.id] },
    ],
    reporting: { [coo.id]: [admin.id, architect.id] },
  },
};
const writes = [], errors = [];

await context.routeWebSocket("**/realtime/**", (socket) => socket.close());
await context.route("**/*.supabase.co/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  let data = [];
  if (url.pathname.includes("/auth/")) {
    const token = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "00000000-0000-4000-8000-000000000001", role: "authenticated" })).toString("base64url");
    data = { access_token: `eyJhbGciOiJIUzI1NiJ9.${token}.test`, refresh_token: "test", token_type: "bearer", expires_in: 3600, user: { id: "00000000-0000-4000-8000-000000000001", role: "authenticated", is_anonymous: true } };
  } else if (url.pathname.endsWith("/functions/v1/auth-policy")) {
    const body = request.postDataJSON();
    if (body.op === "status") data = { ok: true, required: false, policy: { enabled: false } };
    else if (body.op === "amPlatformAdmin") data = { ok: true, admin: true };
    else data = { ok: true, rows: [] };
  } else if (url.pathname.endsWith("/rpc/server_now")) data = new Date().toISOString();
  else if (url.pathname.endsWith("/app_state")) {
    const key = url.searchParams.get("store_key");
    data = key?.startsWith("eq.") ? { data: key === "eq.larsaStaffV8" ? staff : {}, updated_at: new Date().toISOString() } : [{ store_key: "larsaStaffV8", data: staff, updated_at: new Date().toISOString() }];
  } else if (url.pathname.endsWith("/rpc/app_state_put")) {
    const body = request.postDataJSON();
    if (body.p_store_key === "larsaStaffV8") { staff = body.p_data; writes.push(body.p_data); }
    data = [{ applied: true, current_data: body.p_data, current_updated_at: new Date().toISOString() }];
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data), headers: { "access-control-allow-origin": "*" } }).catch(() => {});
});

await context.addInitScript(({ staff, admin }) => {
  if (localStorage.getItem("structure-2-seeded")) return;
  localStorage.setItem("structure-2-seeded", "1");
  localStorage.setItem("larsaStaffV8", JSON.stringify(staff));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: admin, method: "email" }));
}, { staff, admin });

const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));

async function openOrganizationChart() {
  await page.locator(".top-signout").waitFor({ timeout: 30000 });
  const module = page.getByText("Engineering Management", { exact: true }).last();
  if (await module.isVisible().catch(() => false)) await module.click();
  await page.getByRole("tab", { name: "Organization Chart", exact: true }).click();
  await page.locator(".native.active .structure2").waitFor();
}

try {
  await page.goto(process.env.SMOKE_URL || "http://localhost:5199/", { waitUntil: "domcontentloaded" });
  await openOrganizationChart();
  const panel = page.locator(".native.active .structure2");
  assert.equal(await page.getByRole("tab", { name: "Structure", exact: true }).count(), 0, "old Structure tab must be removed");
  assert.equal(await page.getByRole("tab", { name: "Structure 2", exact: true }).count(), 0, "proposal tab must be removed");
  assert.equal(await page.getByRole("tab", { name: "Organization Chart", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await panel.getByText("Casey Operations", { exact: true }).first().isVisible(), true);
  assert.equal(await panel.getByText("Architecture A", { exact: true }).first().isVisible(), true);

  const engineerCard = panel.locator(".s2-palette-person").filter({ hasText: "Erin Engineer" });
  const architectureTeam = panel.locator(".s2-team").filter({ hasText: "Architecture A" });
  const leadZone = architectureTeam.locator(".s2-dropzone").filter({ hasText: "Team lead" });
  const dragData = await page.evaluateHandle(() => new DataTransfer());
  await engineerCard.dispatchEvent("dragstart", { dataTransfer: dragData });
  await leadZone.dispatchEvent("dragenter", { dataTransfer: dragData });
  await leadZone.dispatchEvent("dragover", { dataTransfer: dragData });
  await leadZone.dispatchEvent("drop", { dataTransfer: dragData });
  await engineerCard.dispatchEvent("dragend", { dataTransfer: dragData });
  await leadZone.getByText("Erin Engineer", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Save changes", exact: true }).isEnabled(), true);
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.equal(await leadZone.getByText("Erin Engineer", { exact: true }).count(), 0, "Discard must undo a drag assignment");

  await panel.getByRole("tab", { name: "Matrix", exact: true }).click();
  await panel.getByText("One person, every role", { exact: true }).waitFor();
  const cooRow = panel.locator(".s2-matrix tbody tr").filter({ hasText: "Casey Operations" });
  assert.match(await cooRow.innerText(), /Operations/);
  assert.match(await cooRow.innerText(), /Architecture A/);
  assert.match(await cooRow.innerText(), /Admin Owner/);
  assert.match(await cooRow.innerText(), /Alex Architect/);
  await cooRow.getByRole("button", { name: "Edit", exact: true }).click();
  const inspector = page.locator(".s2-inspector");
  await inspector.getByText("Casey Operations", { exact: true }).waitFor();
  assert.equal(await inspector.getByText("Admin Owner", { exact: true }).count(), 1);
  assert.equal(await inspector.getByText("Alex Architect", { exact: true }).count(), 1);
  const operations = inspector.locator(".s2-team-assignments > div").filter({ hasText: "Operations" });
  assert.equal(await operations.getByLabel("Member", { exact: true }).isChecked(), true);
  await operations.getByLabel("Lead", { exact: true }).check();
  await inspector.getByRole("button", { name: "Close assignments", exact: true }).click();
  await panel.getByRole("button", { name: "Save changes", exact: true }).click();
  await panel.getByText("Organization changes saved to the company server.", { exact: true }).waitFor();
  assert.ok(writes.length > 0, "save must reach the synchronized company document");
  assert.ok(staff.org.teams.find((team) => team.id === "team-operations").leadIds.includes(coo.id), "saved overlapping lead role missing");

  await page.screenshot({ path: ".organization-chart-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  const closeNavigation = page.getByRole("button", { name: "Close navigation", exact: true });
  if (await closeNavigation.isVisible().catch(() => false)) { await closeNavigation.evaluate((button) => button.click()); await page.waitForTimeout(350); }
  await panel.getByRole("tab", { name: "Organization chart", exact: true }).click();
  for (const name of ["Organization chart", "Matrix"]) {
    const locator = panel.getByRole("tab", { name, exact: true });
    const box = await locator.boundingBox();
    const geometry = await locator.evaluate((node) => {
      const rows = [];
      for (let el = node; el && rows.length < 7; el = el.parentElement) {
        const rect = el.getBoundingClientRect();
        rows.push({ className: el.className, x: rect.x, width: rect.width, scrollWidth: el.scrollWidth });
      }
      return rows;
    });
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} must remain inside the mobile viewport: ${JSON.stringify(geometry)}`);
  }
  for (const name of ["Discard", "Save changes"]) {
    const box = await panel.getByRole("button", { name, exact: true }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} must remain inside the mobile viewport`);
  }
  await page.screenshot({ path: ".organization-chart-mobile.png", fullPage: false });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Organization Chart must not overflow the page on mobile");
  assert.deepEqual(errors, []);
  console.log("PASS Organization Chart: old Structure removed, drag/discard, matrix, overlapping roles, reporting, save/sync, mobile");
} catch (error) {
  console.error("ORGANIZATION CHART UI DIAGNOSTIC", (await page.locator("body").innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
