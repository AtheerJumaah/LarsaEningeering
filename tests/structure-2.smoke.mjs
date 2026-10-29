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
const extraPeople = Array.from({ length: 22 }, (_, index) => ({ id: `extra-${index + 1}`, name: `Employee ${String(index + 1).padStart(2, "0")}`, email: `employee-${index + 1}@example.invalid`, enabled: true, access: "Employee", role: index % 2 ? "Engineer" : "Staff" }));
let staff = {
  users: [admin, coo, architect, engineer, ...extraPeople],
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

  const directory = panel.locator(".s2-people-palette");
  const people = directory.locator(".s2-palette-person");
  assert.match(await people.first().innerText(), /Admin Owner/, "people must initially sort by first name A–Z");
  await directory.getByRole("button", { name: "Z–A", exact: true }).click();
  assert.match(await people.first().innerText(), /Erin Engineer/, "people must optionally sort by first name Z–A");
  await directory.getByRole("button", { name: "Hide names", exact: true }).click();
  assert.equal(await people.count(), 0, "the names drawer must collapse");
  await directory.getByRole("button", { name: "Show all 26 names", exact: true }).click();
  await directory.getByRole("button", { name: "A–Z", exact: true }).click();
  assert.equal(await people.count(), 26, "the expanded directory must expose every active name");
  assert.equal(await directory.locator(".s2-palette-list").evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true, "the desktop directory must not hide names in a second inner scroller");
  await directory.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".people-directory-desktop.png", fullPage: false });

  const buildDepartments = panel.locator(".s2-department");
  const managementBuildDepartment = buildDepartments.filter({ hasText: "Management" });
  const architectureBuildDepartment = buildDepartments.filter({ hasText: "Architecture" });
  assert.deepEqual(await buildDepartments.locator(":scope > .s2-department-head h4").allTextContents(), ["Management", "Architecture"]);
  const buildDepartmentDragData = await page.evaluateHandle(() => new DataTransfer());
  await architectureBuildDepartment.getByLabel("Move department Architecture", { exact: true }).dispatchEvent("dragstart", { dataTransfer: buildDepartmentDragData });
  await managementBuildDepartment.dispatchEvent("dragenter", { dataTransfer: buildDepartmentDragData });
  await managementBuildDepartment.dispatchEvent("dragover", { dataTransfer: buildDepartmentDragData });
  await managementBuildDepartment.dispatchEvent("drop", { dataTransfer: buildDepartmentDragData });
  assert.deepEqual(await buildDepartments.locator(":scope > .s2-department-head h4").allTextContents(), ["Architecture", "Management"], "Build chart departments must switch vertical positions by drag and drop");
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.deepEqual(await buildDepartments.locator(":scope > .s2-department-head h4").allTextContents(), ["Management", "Architecture"], "Discard must restore Build chart department order");

  const buildOperationsTeam = panel.locator(".s2-team").filter({ has: page.getByText("Operations", { exact: true }) });
  const buildArchitectureTeam = panel.locator(".s2-team").filter({ has: page.getByText("Architecture A", { exact: true }) });
  const buildTeamDragData = await page.evaluateHandle(() => new DataTransfer());
  await buildOperationsTeam.getByLabel("Move Operations", { exact: true }).dispatchEvent("dragstart", { dataTransfer: buildTeamDragData });
  await buildArchitectureTeam.dispatchEvent("dragenter", { dataTransfer: buildTeamDragData });
  await buildArchitectureTeam.dispatchEvent("dragover", { dataTransfer: buildTeamDragData });
  await buildArchitectureTeam.dispatchEvent("drop", { dataTransfer: buildTeamDragData });
  assert.deepEqual(await architectureBuildDepartment.locator(".s2-team > header b").allTextContents(), ["Operations", "Architecture A"], "dropping a Build chart team on another team must move it into that department");
  const reverseBuildTeamDragData = await page.evaluateHandle(() => new DataTransfer());
  await buildArchitectureTeam.getByLabel("Move Architecture A", { exact: true }).dispatchEvent("dragstart", { dataTransfer: reverseBuildTeamDragData });
  await buildOperationsTeam.dispatchEvent("dragenter", { dataTransfer: reverseBuildTeamDragData });
  await buildOperationsTeam.dispatchEvent("dragover", { dataTransfer: reverseBuildTeamDragData });
  await buildOperationsTeam.dispatchEvent("drop", { dataTransfer: reverseBuildTeamDragData });
  assert.deepEqual(await architectureBuildDepartment.locator(".s2-team > header b").allTextContents(), ["Architecture A", "Operations"], "Build chart team cards must switch places inside a department");
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.equal(await architectureBuildDepartment.locator(".s2-team").count(), 1, "Discard must restore Build chart team placement");

  const cooPosition = panel.locator(".s2-executive-position").filter({ has: page.locator("header b", { hasText: /^Chief Operating Officer \(COO\)$/ }) });
  assert.equal(await cooPosition.getByText("Casey Operations", { exact: true }).isVisible(), true, "existing executive titles must be recognized");
  const executiveZone = cooPosition.locator(".s2-dropzone");
  await executiveZone.getByRole("button", { name: "Choose person", exact: true }).click();
  const picker = page.locator(".s2-picker");
  await picker.getByText("Choose position holder", { exact: true }).waitFor();
  assert.equal(await picker.locator(".s2-picker-list > button").count(), 26, "the role picker must show every active person");
  await page.screenshot({ path: ".people-picker-desktop.png", fullPage: false });
  await picker.getByLabel("Search all people", { exact: true }).fill("Erin");
  await picker.getByRole("button", { name: "Select Erin Engineer", exact: true }).click();
  await executiveZone.getByText("Erin Engineer", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.equal(await executiveZone.getByText("Erin Engineer", { exact: true }).count(), 0, "picker assignment must participate in discard/save workflow");

  const engineerCard = panel.locator(".s2-palette-person").filter({ hasText: "Erin Engineer" });
  const scrollSurface = page.locator(".native.active");
  const scrollDragData = await page.evaluateHandle(() => new DataTransfer());
  await scrollSurface.evaluate((node) => { node.scrollTop = 0; });
  await engineerCard.dispatchEvent("dragstart", { dataTransfer: scrollDragData });
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: innerHeight - 2, dataTransfer: new DataTransfer() })));
  await page.waitForTimeout(350);
  const scrolledDown = await scrollSurface.evaluate((node) => node.scrollTop);
  assert.ok(scrolledDown > 0, "dragging near the bottom must scroll the whole organization chart down");
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: 1, dataTransfer: new DataTransfer() })));
  await page.waitForTimeout(350);
  assert.ok(await scrollSurface.evaluate((node) => node.scrollTop) < scrolledDown, "dragging near the top must scroll the whole organization chart up");
  await engineerCard.dispatchEvent("dragend", { dataTransfer: scrollDragData });
  await scrollSurface.evaluate((node) => { node.scrollTop = 0; });

  const executiveDragData = await page.evaluateHandle(() => new DataTransfer());
  await engineerCard.dispatchEvent("dragstart", { dataTransfer: executiveDragData });
  await executiveZone.dispatchEvent("dragenter", { dataTransfer: executiveDragData });
  await executiveZone.dispatchEvent("dragover", { dataTransfer: executiveDragData });
  await executiveZone.dispatchEvent("drop", { dataTransfer: executiveDragData });
  await engineerCard.dispatchEvent("dragend", { dataTransfer: executiveDragData });
  await executiveZone.getByText("Erin Engineer", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Save changes", exact: true }).click();
  await panel.getByText("Organization changes saved to the company server.", { exact: true }).waitFor();
  assert.ok(staff.org.executivePositions.find((position) => position.title.includes("COO")).personIds.includes(engineer.id), "executive assignment must save");

  const managingPosition = panel.locator(".s2-executive-position").filter({ has: page.locator("header b", { hasText: /^Managing Director$/ }) });
  await cooPosition.getByText("Reporting lines", { exact: true }).click();
  await managingPosition.getByText("Reporting lines", { exact: true }).click();
  await cooPosition.getByLabel("Add who Chief Operating Officer (COO) reports to", { exact: true }).selectOption({ label: "Managing Director — Admin Owner" });
  assert.equal(await cooPosition.getByText("Managing Director — Admin Owner", { exact: true }).isVisible(), true, "an executive position must show who it reports to");
  assert.equal(await managingPosition.getByText("Chief Operating Officer (COO) — Casey Operations, Erin Engineer", { exact: true }).isVisible(), true, "the reverse direct-report relationship must update immediately");
  const managingReportsTo = managingPosition.getByLabel("Add who Managing Director reports to", { exact: true });
  assert.equal(await managingReportsTo.locator("option").filter({ hasText: "Chief Operating Officer (COO)" }).count(), 0, "a reporting cycle must not be offered");
  await panel.getByRole("button", { name: "Save changes", exact: true }).click();
  await panel.getByText("Organization changes saved to the company server.", { exact: true }).waitFor();
  const savedCooPosition = staff.org.executivePositions.find((position) => position.title.includes("COO"));
  const savedManagingPosition = staff.org.executivePositions.find((position) => position.title === "Managing Director");
  assert.deepEqual(savedCooPosition.reportsToPositionIds, [savedManagingPosition.id], "executive reporting must persist to the company document");

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
  assert.match(await cooRow.innerText(), /Chief Operating Officer \(COO\)/);
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

  await panel.getByRole("tab", { name: "Visual chart", exact: true }).click();
  await panel.getByText("Company reporting structure", { exact: true }).waitFor();
  const diagram = panel.locator(".s2-diagram-card");
  await diagram.getByText("Interactive visual organization chart", { exact: true }).waitFor();
  const zoomOutput = diagram.locator(".s2-diagram-zoom output");
  assert.equal(await zoomOutput.innerText(), "100%", "the visual chart should open at a predictable scale");
  await diagram.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(await zoomOutput.innerText(), "110%", "the visual chart must zoom interactively");
  await diagram.getByRole("button", { name: "Reset view", exact: true }).click();
  assert.equal(await zoomOutput.innerText(), "100%", "Reset view must restore the default zoom");
  await diagram.getByRole("button", { name: "Fit chart", exact: true }).click();
  const fittedZoom = Number((await zoomOutput.innerText()).replace("%", ""));
  assert.ok(fittedZoom >= 60 && fittedZoom <= 100, `Fit chart must choose a safe visible scale, received ${fittedZoom}%`);
  await diagram.getByRole("button", { name: "Reset view", exact: true }).click();
  for (let step = 0; step < 5; step += 1) await diagram.getByRole("button", { name: "Zoom in", exact: true }).click();
  const diagramSurface = diagram.locator(".s2-diagram-scroll");
  assert.equal(await diagramSurface.evaluate((node) => node.scrollWidth > node.clientWidth), true, "zooming must create a navigable visual canvas");
  await diagramSurface.evaluate((node) => { node.scrollLeft = Math.min(180, node.scrollWidth - node.clientWidth); });
  const panStart = await diagramSurface.evaluate((node) => node.scrollLeft);
  const diagramSurfaceBox = await diagramSurface.boundingBox();
  assert.ok(diagramSurfaceBox, "visual canvas must have measurable bounds");
  await page.mouse.move(diagramSurfaceBox.x + 5, diagramSurfaceBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(diagramSurfaceBox.x + 75, diagramSurfaceBox.y + 5, { steps: 4 });
  await page.mouse.up();
  const panEnd = await diagramSurface.evaluate((node) => node.scrollLeft);
  assert.ok(panEnd < panStart, `dragging the visual background must pan the chart (${panStart} -> ${panEnd})`);
  await diagram.getByRole("button", { name: "Reset view", exact: true }).click();
  assert.equal(await diagram.getByText("Management", { exact: true }).isVisible(), true);
  assert.equal(await diagram.getByText("Architecture", { exact: true }).isVisible(), true);
  assert.equal(await diagram.getByText("Operations", { exact: true }).isVisible(), true);
  assert.equal(await diagram.getByText("Architecture A", { exact: true }).isVisible(), true);
  assert.equal(await diagram.getByText("Casey Operations", { exact: true }).first().isVisible(), true);
  const cooDiagramNode = diagram.locator(".s2-diagram-node.executive").filter({ has: page.locator("h5", { hasText: /^Chief Operating Officer \(COO\)$/ }) });
  const managingDiagramNode = diagram.locator(".s2-diagram-node.executive").filter({ has: page.locator("h5", { hasText: /^Managing Director$/ }) });
  assert.match(await cooDiagramNode.innerText(), /REPORTS TO[\s\S]*Managing Director/, "visual chart must show the executive manager");
  assert.match(await managingDiagramNode.innerText(), /DIRECT REPORTS[\s\S]*Chief Operating Officer \(COO\)/, "visual chart must show derived direct reports");
  await diagram.getByRole("button", { name: "Hide employee names", exact: true }).click();
  assert.equal(await diagram.getByText("Casey Operations", { exact: true }).count(), 0, "visual chart must optionally hide employee names");
  assert.ok(await diagram.locator(".s2-diagram-count").count() > 0, "hidden names must leave useful employee counts");
  await diagram.getByRole("button", { name: "Show employee names", exact: true }).click();
  await diagram.getByText("Casey Operations", { exact: true }).first().click();
  await inspector.getByText("Casey Operations", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Close assignments", exact: true }).click();

  const departmentNodes = diagram.locator(".s2-diagram-node.department");
  assert.deepEqual(await departmentNodes.locator("h5").allTextContents(), ["Management", "Architecture"]);
  const managementNode = departmentNodes.filter({ hasText: "Management" });
  const architectureNode = departmentNodes.filter({ hasText: "Architecture" });
  const departmentDragData = await page.evaluateHandle(() => new DataTransfer());
  await architectureNode.getByLabel("Move Architecture", { exact: true }).dispatchEvent("dragstart", { dataTransfer: departmentDragData });
  await managementNode.dispatchEvent("dragover", { dataTransfer: departmentDragData });
  await managementNode.dispatchEvent("drop", { dataTransfer: departmentDragData });
  assert.deepEqual(await departmentNodes.locator("h5").allTextContents(), ["Architecture", "Management"], "department cards must reorder by drag and drop");
  assert.equal(await panel.getByRole("button", { name: "Save changes", exact: true }).isEnabled(), true, "diagram moves must join the explicit save workflow");
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.deepEqual(await departmentNodes.locator("h5").allTextContents(), ["Management", "Architecture"], "Discard must restore diagram order");
  const reverseDepartmentDragData = await page.evaluateHandle(() => new DataTransfer());
  await managementNode.getByLabel("Move Management", { exact: true }).dispatchEvent("dragstart", { dataTransfer: reverseDepartmentDragData });
  await architectureNode.dispatchEvent("dragover", { dataTransfer: reverseDepartmentDragData });
  await architectureNode.dispatchEvent("drop", { dataTransfer: reverseDepartmentDragData });
  assert.deepEqual(await departmentNodes.locator("h5").allTextContents(), ["Architecture", "Management"], "department cards must switch positions in either drag direction");
  await panel.getByRole("button", { name: "Discard", exact: true }).click();

  const operationsNode = diagram.locator(".s2-diagram-node.team").filter({ hasText: "Operations" });
  const architectureTeamNode = diagram.locator(".s2-diagram-node.team").filter({ hasText: "Architecture A" });
  const teamDragData = await page.evaluateHandle(() => new DataTransfer());
  await operationsNode.getByLabel("Move Operations", { exact: true }).dispatchEvent("dragstart", { dataTransfer: teamDragData });
  await architectureTeamNode.dispatchEvent("dragover", { dataTransfer: teamDragData });
  await architectureTeamNode.dispatchEvent("drop", { dataTransfer: teamDragData });
  const architectureBranch = diagram.locator(".s2-diagram-branch").nth(1);
  assert.equal(await architectureBranch.locator(".s2-diagram-node.team").count(), 2, "a team must move between departments from the visual chart");
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  assert.equal(await architectureBranch.locator(".s2-diagram-node.team").count(), 1, "Discard must restore a moved team");
  await page.screenshot({ path: ".organization-diagram-desktop.png", fullPage: false });

  await panel.getByRole("tab", { name: "Build chart", exact: true }).click();
  await page.screenshot({ path: ".organization-chart-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  const closeNavigation = page.getByRole("button", { name: "Close navigation", exact: true });
  if (await closeNavigation.isVisible().catch(() => false)) { await closeNavigation.evaluate((button) => button.click()); await page.waitForTimeout(350); }
  await panel.getByRole("tab", { name: "Build chart", exact: true }).click();
  for (const name of ["Build chart", "Visual chart", "Matrix"]) {
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
  await panel.getByRole("tab", { name: "Visual chart", exact: true }).click();
  const mobileDiagramScroll = panel.locator(".s2-diagram-scroll");
  assert.equal(await mobileDiagramScroll.evaluate((node) => node.scrollWidth > node.clientWidth), true, "the figurative chart must provide its own horizontal navigation on mobile");
  await panel.getByRole("tab", { name: "Build chart", exact: true }).click();
  await panel.getByRole("button", { name: "Choose person", exact: true }).first().click();
  const mobilePicker = page.locator(".s2-picker");
  await mobilePicker.waitFor();
  const pickerBox = await mobilePicker.boundingBox();
  assert.ok(pickerBox && pickerBox.x >= 0 && pickerBox.x + pickerBox.width <= 390, "the full people picker must fit the mobile viewport");
  assert.equal(await mobilePicker.locator(".s2-picker-list > button").count(), 26, "the mobile picker must make every name reachable");
  await mobilePicker.getByRole("button", { name: "Close people directory", exact: true }).click();
  await page.screenshot({ path: ".organization-chart-mobile.png", fullPage: false });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Organization Chart must not overflow the page on mobile");
  assert.deepEqual(errors, []);
  console.log("PASS Organization Chart: people drawer/sort, builder, movable visual diagram, matrix, overlapping roles, reporting, save/sync, mobile");
} catch (error) {
  console.error("ORGANIZATION CHART UI DIAGNOSTIC", (await page.locator("body").innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
