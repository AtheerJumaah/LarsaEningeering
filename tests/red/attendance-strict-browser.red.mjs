/*
 * Strict-mode attendance browser gate.
 *
 * This suite intentionally lives under tests/red: it is a release gate for
 * the future Auth-to-staff cutover, not part of the compatibility-mode suite.
 * Run it against a local Next server built with
 * NEXT_PUBLIC_LARSA_ATTENDANCE_AUTH_BINDING=on and synthetic Supabase routes:
 *
 *   node tests/red/attendance-strict-browser.red.mjs
 *
 * No production URL, credentials, staff IDs, or database writes are used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
);
const executablePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
assert.ok(existsSync(executablePath), `Chrome not found at ${executablePath}`);

const SMOKE_URL = process.env.STRICT_SMOKE_URL || process.env.SMOKE_URL || "http://localhost:5200/";
const staffA = { id: "strict-employee-a", name: "Strict Employee A", email: "strict-a@example.test", role: "Engineer", access: "Engineer", enabled: true, active: true };
const staffB = { id: "strict-employee-b", name: "Strict Employee B", email: "strict-b@example.test", role: "Engineer", access: "Engineer", enabled: true, active: true };
const authA = { id: "00000000-0000-4000-8000-000000000011", aud: "authenticated", role: "authenticated", is_anonymous: false };
const authAnonymous = { id: "00000000-0000-4000-8000-000000000099", aud: "authenticated", role: "authenticated", is_anonymous: true };

function jwtFor(user) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: user.id, role: "authenticated" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.synthetic`;
}

async function makeContext({
  authMode = "anonymous",
  rpcMode = "recorded",
  delayUser = false,
  deniedStorage = false,
  initialStaff = staffA,
} = {}) {
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const state = {
    authMode,
    rpcMode,
    delayUser,
    releaseUser: null,
    rpcCalls: [],
    events: [],
    staff: { users: [staffA, staffB], logs: [] },
    stamp: new Date().toISOString(),
  };
  await context.route("**/*.supabase.co/**", async (route) => {
    const request = route.request();
    const pathname = new globalThis.URL(request.url()).pathname;
    let body;
    if (pathname.includes("/auth/")) {
      if (pathname.endsWith("/user")) {
        const user = state.authMode === "anonymous" ? authAnonymous : authA;
        if (state.delayUser) await new Promise((resolve) => { state.releaseUser = resolve; });
        body = { user };
      } else if (pathname.endsWith("/logout")) {
        body = {};
      } else {
        /* Sync bootstrap may ask for an anonymous session. The strict punch
           path itself is controlled by /user above. */
        body = {
          access_token: jwtFor(authA),
          refresh_token: "synthetic-refresh",
          token_type: "bearer",
          expires_in: 3600,
          user: authA,
        };
      }
    } else if (pathname.endsWith("/rpc/server_now")) {
      body = new Date().toISOString();
    } else if (pathname.endsWith("/rpc/record_attendance_action")) {
      const payload = request.postDataJSON();
      state.rpcCalls.push(payload);
      if (state.rpcMode === "forbidden") {
        await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "synthetic authorization denied" }) });
        return;
      }
      if (state.rpcMode === "needs_review") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "22023", message: "expired_needs_correction" }) });
        return;
      }
      if (state.rpcMode === "unavailable") {
        await route.abort("failed");
        return;
      }
      const existing = state.events.find((event) => event.client_event_id === payload.p_client_event_id);
      if (existing) {
        body = [{ outcome: "already", current_status: existing.status, current_at: existing.occurred_at, event_id: existing.client_event_id }];
      } else {
        const latest = [...state.events].reverse().find((event) => event.uid === payload.p_uid && ["In", "Out", "Break Start", "Break End"].includes(event.status));
        if (latest?.status === payload.p_status) {
          body = [{ outcome: "already", current_status: latest.status, current_at: latest.occurred_at, event_id: latest.client_event_id }];
        } else {
          const event = {
            client_event_id: payload.p_client_event_id,
            occurred_at: payload.p_occurred_at,
            uid: payload.p_uid,
            status: payload.p_status,
          };
          state.events.push(event);
          body = [{ outcome: "recorded", current_status: event.status, current_at: event.occurred_at, event_id: event.client_event_id }];
        }
      }
    } else if (pathname.endsWith("/rpc/app_state_put")) {
      const payload = request.postDataJSON();
      if (payload.p_store_key === "larsaStaffV8") {
        state.staff = payload.p_data;
        state.stamp = new Date().toISOString();
      }
      body = [{ applied: true, current_data: payload.p_store_key === "larsaStaffV8" ? state.staff : payload.p_data, current_updated_at: state.stamp }];
    } else if (pathname.endsWith("/app_state")) {
      const key = new globalThis.URL(request.url()).searchParams.get("store_key");
      body = key?.startsWith("eq.")
        ? { data: key === "eq.larsaStaffV8" ? state.staff : {}, updated_at: state.stamp }
        : [{ store_key: "larsaStaffV8", data: state.staff, updated_at: state.stamp }];
    } else if (pathname.endsWith("/attendance_events")) {
      body = state.events;
    } else {
      body = {};
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  });
  await context.addInitScript(({ user, deniedStorage }) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (deniedStorage && (key.startsWith("larsaAttendancePunchDeniedV1:") || key.startsWith("larsaAttendanceAuthBlockedV1:"))) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [
      { id: "strict-employee-a", name: "Strict Employee A", email: "strict-a@example.test", enabled: true },
      { id: "strict-employee-b", name: "Strict Employee B", email: "strict-b@example.test", enabled: true },
    ], logs: [] }));
    if (!sessionStorage.getItem("larsa-control-session")) sessionStorage.setItem("larsa-control-session", JSON.stringify({ user, method: "pin" }));
  }, { user: initialStaff, deniedStorage });
  return { browser, context, state };
}

async function openClock(context) {
  const page = await context.newPage();
  await page.goto(SMOKE_URL, { waitUntil: "load" });
  const punch = page.locator(".native.active button.clock-punch");
  await punch.waitFor({ timeout: 20000 });
  return { page, punch };
}

async function waitForText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });
}

async function waitForAuthHold(page, uid = "strict-employee-a") {
  await page.waitForFunction((key) => Boolean(localStorage.getItem(`larsaAttendanceAuthBlockedV1:${key}`) || localStorage.getItem(`larsaAttendancePunchDeniedV1:${key}`)), uid, { timeout: 8000 });
}

test("strict anonymous denial is held once, never falsely succeeds, and does not retry", async () => {
  const { browser, context, state } = await makeContext({ authMode: "anonymous" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await waitForAuthHold(page);
    assert.equal(state.rpcCalls.length, 0, "anonymous strict denial must never call the RPC");
    assert.equal(state.events.length, 0, "denial must not create a server event");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchQueueV1:strict-employee-a") || "[]")), []);
    const denied = await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchReviewV1:strict-employee-a") || localStorage.getItem("larsaAttendanceAuthBlockedV1:strict-employee-a") || localStorage.getItem("larsaAttendancePunchDeniedV1:strict-employee-a") || "[]"));
    assert.equal(denied.length, 1);
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(state.rpcCalls.length, 0, "held denial must not enter the retry loop");
  } finally {
    await browser.close();
  }
});

test("strict denied action has an actionable recovery path after sign-in", async () => {
  const { browser, context, state } = await makeContext({ authMode: "anonymous" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await waitForAuthHold(page);
    /* This is intentionally a red gate until the product exposes a clear
       recovery action. A stored denied event that only exists in DevTools is
       stranded, even though the first denial itself is safe. */
    const recovery = page.getByRole("button", { name: /retry|recover|submit.*review|attendance correction/i }).first();
    await recovery.waitFor({ timeout: 2000 });
    await recovery.click();
    state.authMode = "approved";
    /* The local staff snapshot can briefly render the post-punch label before
       the synthetic RPC route has observed the request. Make the acceptance
       gate wait on the authoritative fixture call, then verify the UI. */
    const replayDeadline = Date.now() + 10000;
    while (state.rpcCalls.length < 1 && Date.now() < replayDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock Out"), null, { timeout: 2000 });
    assert.ok(state.rpcCalls.length >= 1);
    assert.equal(new Set(state.rpcCalls.map((call) => call.p_client_event_id)).size, 1, "recovery must preserve one logical event id across any idempotent transport retry");
    assert.equal(state.events.length, 1, "the synthetic ledger must contain one committed event");
    assert.equal(state.events[0].status, "In");
    assert.equal(state.rpcCalls[0].p_client_event_id, state.events[0].client_event_id);
  } finally {
    await browser.close();
  }
});

test("server authorization denial is terminal, not an outage retry", async () => {
  const { browser, context, state } = await makeContext({ authMode: "approved", rpcMode: "forbidden" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    const denialDeadline = Date.now() + 5000;
    while (state.rpcCalls.length < 1 && Date.now() < denialDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.rpcCalls.length, 1);
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(state.rpcCalls.length, 1, "403/42501 must not be retried as unavailable");
    const denied = await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchReviewV1:strict-employee-a") || localStorage.getItem("larsaAttendanceAuthBlockedV1:strict-employee-a") || localStorage.getItem("larsaAttendancePunchDeniedV1:strict-employee-a") || "[]"));
    assert.equal(denied.length, 1);
  } finally {
    await browser.close();
  }
});

test("denied events are private across a same-browser account switch", async () => {
  const { browser, context, state } = await makeContext({ authMode: "anonymous" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await waitForAuthHold(page);
    await page.evaluate(() => {
      const key = localStorage.getItem("larsaAttendanceAuthBlockedV1:strict-employee-a") ? "larsaAttendanceAuthBlockedV1:strict-employee-a" : "larsaAttendancePunchDeniedV1:strict-employee-a";
      const held = JSON.parse(localStorage.getItem(key) || "[]");
      held[0].note = "PRIVATE-HOLD-SECRET-A";
      localStorage.setItem(key, JSON.stringify(held));
    });
    await page.evaluate(() => sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: { id: "strict-employee-b", name: "Strict Employee B", email: "strict-b@example.test", enabled: true }, method: "pin" })));
    await page.reload();
    await page.locator(".native.active button.clock-punch").waitFor({ timeout: 20000 });
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("PRIVATE-HOLD-SECRET-A")), false);
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(state.rpcCalls.length, 0, "employee B must not retry employee A's denied event");
    const aHold = await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendanceAuthBlockedV1:strict-employee-a") || localStorage.getItem("larsaAttendancePunchDeniedV1:strict-employee-a") || "[]"));
    assert.equal(aHold.length, 1, "switching accounts must not destroy employee A's evidence");
  } finally {
    await browser.close();
  }
});

test("account switch during a pending Auth lookup sends no late punch", async () => {
  const { browser, context, state } = await makeContext({ authMode: "approved", delayUser: true });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await page.getByRole("button", { name: "Sign out" }).last().click();
    state.releaseUser?.();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(state.rpcCalls.length, 0, "a late Auth result must not punch after sign-out");
    assert.equal(state.events.length, 0);
  } finally {
    await browser.close();
  }
});

test("storage failure during strict denial never claims the action was held", async () => {
  const { browser, context, state } = await makeContext({ authMode: "anonymous", deniedStorage: true });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await waitForText(page, "could not be held safely");
    assert.equal(state.rpcCalls.length, 0);
    assert.equal(state.events.length, 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("larsaAttendanceAuthBlockedV1:strict-employee-a") || localStorage.getItem("larsaAttendancePunchDeniedV1:strict-employee-a")), null);
  } finally {
    await browser.close();
  }
});

test("stale tab cannot drain another employee's pending queue after account switch", async () => {
  const { browser, context, state } = await makeContext({ authMode: "approved", rpcMode: "unavailable" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await page.getByText(/Pending synchronization: 1 action/i).waitFor({ timeout: 5000 });
    const second = await context.newPage();
    await second.goto(SMOKE_URL, { waitUntil: "load" });
    await second.evaluate(() => sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: { id: "strict-employee-b", name: "Strict Employee B", email: "strict-b@example.test", enabled: true }, method: "pin" })));
    await second.reload();
    await second.locator(".native.active button.clock-punch").waitFor({ timeout: 20000 });
    state.rpcMode = "recorded";
    const callsBeforeSwitch = state.rpcCalls.length;
    await second.evaluate(() => window.dispatchEvent(new Event("online")));
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(state.rpcCalls.slice(callsBeforeSwitch).some((call) => call.p_uid === "strict-employee-a"), false, "employee B must not drain employee A's queue");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchQueueV1:strict-employee-a") || "[]").length), 1);
  } finally {
    await browser.close();
  }
});

test("expired or out-of-order punch becomes a review handoff, not a retry loop", async () => {
  const { browser, context, state } = await makeContext({ authMode: "approved", rpcMode: "needs_review" });
  try {
    const { page, punch } = await openClock(context);
    await page.waitForFunction(() => document.querySelector(".native.active button.clock-punch")?.textContent.includes("Clock In"));
    await punch.click();
    await page.getByText(/delayed action.*attendance correction/i).waitFor({ timeout: 8000 });
    const callsAfterFirst = state.rpcCalls.length;
    assert.equal(callsAfterFirst, 1);
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(state.rpcCalls.length, callsAfterFirst, "review handoff must not be retried automatically");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchQueueV1:strict-employee-a") || "[]").length), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("larsaAttendancePunchReviewV1:strict-employee-a") || "[]").length), 1);
    await page.getByRole("button", { name: /add or fix past hours|correction/i }).first().waitFor({ timeout: 2000 });
  } finally {
    await browser.close();
  }
});
