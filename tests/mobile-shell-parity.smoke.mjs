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
const staff = { users: [admin], logs: [], org: { departments: [], teams: [], reporting: {} } };

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
  console.log("PASS mobile shell: same navigation, heading, clocks, actions, and content hierarchy as desktop");
} finally {
  await browser.close();
}
