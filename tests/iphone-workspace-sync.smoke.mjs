// Run with SMOKE_SCRIPT=tests/iphone-workspace-sync.smoke.mjs and
// tests/attendance-freeze-local.smoke.mjs. No company endpoints are used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { webkit, devices } = require(process.env.PLAYWRIGHT_MODULE
  || join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const browser = await webkit.launch();
const user = { id: "qa-iphone", name: "QA Employee", email: "iphone@example.invalid", password: "QA-local-only", enabled: true, access: "Engineer" };
const staff = { users: [user], logs: [] };
const stamp = "2026-11-15T12:00:00.000Z";
const token = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: user.id })).toString("base64url");
const session = { access_token: `eyJhbGciOiJIUzI1NiJ9.${token}.test`, refresh_token: "test", token_type: "bearer", expires_in: 3600, user: { id: user.id, role: "authenticated", is_anonymous: true } };

async function scenario(cached, stallAuth = false) {
  const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
  let staffReads = 0;
  let authAttempts = 0;
  let acceptedStaffWrites = 0;
  let serverAvailable = false;
  try {
    await context.routeWebSocket("**/realtime/**", (socket) => socket.close());
    await context.route("**/*.supabase.co/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": route.request().headers()["access-control-request-headers"] || "*",
        } });
        return;
      }
      let data = [];
      if (url.pathname.includes("/auth/v1/")) {
        if (++authAttempts === 1 && stallAuth) return; // No response; the browser must abort.
        data = session;
      } else if (url.pathname.endsWith("/functions/v1/auth-policy")) {
        data = { ok: true, required: false, admin: false };
      } else if (url.pathname.endsWith("/rpc/server_now")) {
        data = stamp;
      } else if (url.pathname.endsWith("/rpc/app_state_put")) {
        if (route.request().postDataJSON()?.p_store_key === "larsaStaffV8" && !serverAvailable) acceptedStaffWrites++;
      } else if (url.pathname.endsWith("/app_state")) {
        const key = url.searchParams.get("store_key");
        if (key === "eq.larsaStaffV8") {
          staffReads++;
          if (cached && !serverAvailable) return; // Stall the roster after cached sign-in.
          if (!cached && staffReads === 1) {
            await route.fulfill({ status: 503, json: { message: "temporary failure" }, headers: { "access-control-allow-origin": "*" } });
            return;
          }
          serverAvailable = true;
          data = [{ data: staff, updated_at: stamp }];
        } else if (key?.startsWith("in.") && key.includes("larsaStaffV8")) {
          data = [{ store_key: "larsaStaffV8", data: staff, updated_at: stamp }];
        }
      }
      await route.fulfill({ status: 200, json: data, headers: { "access-control-allow-origin": "*" } }).catch(() => {});
    });
    await context.addInitScript(({ cached, staff }) => {
      Object.defineProperty(navigator, "standalone", { value: true });
      if (cached) localStorage.setItem("larsaStaffV8", JSON.stringify(staff));
    }, { cached, staff });
    const page = await context.newPage();
    await page.goto(process.env.SMOKE_URL || "http://localhost:5199/");
    const signIn = async () => {
      await page.getByRole("textbox", { name: "Email or username" }).fill(user.email);
      await page.getByLabel("Password", { exact: true }).fill(user.password);
      await page.getByRole("button", { name: "Sign In", exact: true }).click();
    };
    if (cached) {
      await signIn();
      await page.getByRole("heading", { name: "Syncing your workspace…" }).waitFor({ timeout: 10_000 });
      await page.getByRole("heading", { name: "Unable to load your workspace" }).waitFor({ timeout: 18_000 });
      assert.equal(acceptedStaffWrites, 0, "a stale cache cannot publish before it is checked");
      serverAvailable = true;
      await page.getByRole("button", { name: "Try again" }).click();
    } else {
      // Wait without touching the form. The signed-out app must retry by itself.
      await page.waitForFunction(() => Boolean(localStorage.getItem("larsaStaffV8")), undefined, { timeout: 60_000 });
      assert.ok(staffReads >= 2);
      if (stallAuth) assert.ok(authAttempts >= 2, "the stalled auth request released the session lock");
      await signIn();
    }
    await page.locator(".top-signout").waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole("heading", { name: "Syncing your workspace…" }).count(), 0);
    console.log(cached ? "WebKit recovered a stalled signed-in workspace without re-entering credentials."
      : "WebKit recovered signed-out auth and staff sync automatically on a fresh install.");
  } finally {
    await context.close();
  }
}

try {
  await Promise.all([scenario(true), scenario(false, true)]);
} finally {
  await browser.close();
}
