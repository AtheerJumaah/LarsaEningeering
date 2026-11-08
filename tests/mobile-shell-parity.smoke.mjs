// Phone-shell parity check. Supabase is fully intercepted, so this never
// reads or changes company data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
const admin = {
  id: "mobile-admin",
  name: "Mobile Admin",
  email: "mobile-admin@example.invalid",
  enabled: true,
  access: "Super Admin",
  role: "Managing Director",
};
const architect = { id: "mobile-architect", name: "Mobile Architect", email: "architect@example.invalid", enabled: true, access: "Employee", role: "Architecture Department Head", department: "Architecture" };
const engineer = { id: "mobile-engineer", name: "Mobile Engineer", email: "engineer@example.invalid", enabled: true, access: "Employee", role: "Architect", department: "Architecture" };
const operations = { id: "mobile-operations", name: "Mobile Operations", email: "operations@example.invalid", enabled: true, access: "Employee", role: "Chief Operating Officer", department: "Management" };
const staff = {
  users: [admin, architect, engineer, operations],
  logs: [],
  org: {
    departments: [
      { id: "mobile-management", name: "Management", headIds: [admin.id] },
      { id: "mobile-architecture", name: "Architecture", headIds: [architect.id] },
    ],
    teams: [
      { id: "mobile-operations-team", departmentId: "mobile-management", name: "Operations", leadIds: [operations.id], memberIds: [operations.id] },
      { id: "mobile-architecture-team", departmentId: "mobile-architecture", name: "Architecture A", leadIds: [architect.id], memberIds: [architect.id, engineer.id] },
    ],
    executivePositions: [{ id: "mobile-ceo", title: "Chief Executive Officer (CEO)", personIds: [admin.id], reportsToPositionIds: [] }],
    reporting: { [operations.id]: [admin.id], [engineer.id]: [architect.id] },
  },
};

await context.routeWebSocket("**/realtime/**", (socket) => socket.close());
await context.route("**/*.supabase.co/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  let data = [];
  if (url.pathname.includes("/auth/")) {
    const token = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: admin.id, role: "authenticated" })).toString("base64url");
    data = { access_token: `eyJhbGciOiJIUzI1NiJ9.${token}.test`, refresh_token: "test", token_type: "bearer", expires_in: 3600, user: { id: admin.id, role: "authenticated", is_anonymous: true } };
  } else if (url.pathname.endsWith("/functions/v1/auth-policy")) {
    data = { ok: true, required: false, admin: true, rows: [], policy: { enabled: false } };
  } else if (url.pathname.endsWith("/rpc/server_now")) {
    data = new Date().toISOString();
  } else if (url.pathname.endsWith("/app_state")) {
    const key = url.searchParams.get("store_key");
    data = key?.startsWith("eq.")
      ? { data: key === "eq.larsaStaffV8" ? staff : {}, updated_at: new Date().toISOString() }
      : [{ store_key: "larsaStaffV8", data: staff, updated_at: new Date().toISOString() }];
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data), headers: { "access-control-allow-origin": "*" } }).catch(() => {});
});

await context.addInitScript(({ staff, admin }) => {
  localStorage.setItem("larsaStaffV8", JSON.stringify(staff));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: admin, method: "email" }));
}, { staff, admin });

const page = await context.newPage();
try {
  await page.goto(process.env.SMOKE_URL || "http://localhost:5199/", { waitUntil: "domcontentloaded" });
  await page.locator(".top-signout").waitFor({ timeout: 30000 });

  const shell = await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > innerWidth,
    menu: (document.querySelector(".menu-button-label")?.textContent || "").trim(),
    menuVisible: Boolean(document.querySelector(".menu-button")?.getBoundingClientRect().width),
    subtitleVisible: getComputedStyle(document.querySelector(".page-heading p")).display !== "none",
    clocks: [...document.querySelectorAll(".clocks span")].map((node) => ({
      text: node.textContent?.trim(),
      visible: Boolean(node.getBoundingClientRect().width && node.getBoundingClientRect().height),
    })),
    workspaceHeight: document.querySelector(".workspace")?.getBoundingClientRect().height || 0,
  }));

  assert.equal(shell.sideways, false, "the phone shell must not push the document sideways");
  assert.equal(shell.menu, "Menu");
  assert.equal(shell.menuVisible, true);
  assert.equal(shell.subtitleVisible, true, "the desktop page description must remain visible on phone");
  assert.equal(shell.clocks.length, 2);
  assert.ok(shell.clocks.every((clock) => clock.visible), "both desktop clock cards must remain visible on phone");
  assert.ok(shell.workspaceHeight > 500, "the wrapped header must leave a useful workspace");

  await page.getByRole("button", { name: "Show navigation" }).click();
  const drawer = page.locator("aside.sidebar.open");
  await drawer.waitFor();
  await page.waitForTimeout(250);
  const drawerBox = await drawer.boundingBox();
  assert.ok(drawerBox && drawerBox.x >= -1 && drawerBox.x + drawerBox.width <= 391, `the complete desktop navigation must fit inside the phone drawer: ${JSON.stringify(drawerBox)}`);
  assert.equal(await drawer.getByText("Larsa Control", { exact: true }).isVisible(), true);
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await page.waitForTimeout(250);

  // The word "structure" means the whole Organization Chart, not merely the
  // outer app shell. Exercise every representation at phone width and prove
  // that leadership, departments, teams, people, reporting, and matrix rows
  // are the same component/data as desktop rather than a reduced mobile copy.
  await page.getByText("Engineering Management", { exact: true }).last().click();
  await page.getByRole("tab", { name: "Organization Chart", exact: true }).click();
  const organization = page.locator(".native.active .structure2");
  await organization.waitFor();

  const collectStructure = async () => {
    await organization.getByRole("tab", { name: "Build chart", exact: true }).click();
    const build = {
      executives: await organization.locator(".s2-executive-position").count(),
      departments: await organization.locator(".s2-department").count(),
      teams: await organization.locator(".s2-team").count(),
      people: await organization.locator(".s2-palette-person").count(),
      reporting: await organization.locator(".s2-executive-reporting").count(),
    };
    await organization.getByRole("tab", { name: "Visual chart", exact: true }).click();
    const visual = {
      executives: await organization.locator(".s2-diagram-node.executive").count(),
      departments: await organization.locator(".s2-diagram-node.department").count(),
      teams: await organization.locator(".s2-diagram-node.team:not(.empty)").count(),
    };
    await organization.getByRole("tab", { name: "Matrix", exact: true }).click();
    const matrixRows = await organization.locator(".s2-matrix tbody tr").count();
    return { build, visual, matrixRows };
  };

  const phoneStructure = await collectStructure();
  assert.deepEqual(phoneStructure, {
    build: { executives: 1, departments: 2, teams: 2, people: 4, reporting: 1 },
    visual: { executives: 1, departments: 2, teams: 2 },
    matrixRows: 4,
  }, "phone must contain the complete company structure");
  await organization.getByRole("tab", { name: "Build chart", exact: true }).click();
  const phoneStructureSurfaces = organization.locator(".s2-structure-scroll");
  assert.equal(await phoneStructureSurfaces.count(), 2, "phone must expose desktop-layout pan surfaces for leadership and departments");
  for (const surface of await phoneStructureSurfaces.all()) {
    assert.equal(await surface.evaluate((node) => node.scrollWidth > node.clientWidth), true, "each complete desktop structure must be reachable by swiping sideways");
  }
  const phoneTeamColumns = await organization.locator(".s2-team-grid").first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
  assert.ok(phoneTeamColumns > 1, "the phone must retain the desktop multi-column team geometry inside its pan surface");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the whole structure must stay inside the phone page");

  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopStructure = await collectStructure();
  assert.deepEqual(phoneStructure, desktopStructure, "phone and desktop must expose the same organization structure");

  console.log("PASS mobile parity: same shell and complete organization structure as desktop");
} finally {
  await browser.close();
}
