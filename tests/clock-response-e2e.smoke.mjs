/* Larsa Control — clocking in and out, measured.
 *
 * The report was "late response, or I have to click more than once". Both
 * halves of that are measurable, so this measures them rather than eyeballing
 * the button: how long the UI takes to reflect a press, and whether a single
 * press is enough.
 *
 *   node tests/clock-response-e2e.smoke.mjs      # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";
const USER = {
  id: "u-clock", name: "Clock Tester", email: "clock@larsaeng.com",
  role: "Engineer", access: "Engineer", enabled: true, active: true,
};

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.addInitScript((seed) => {
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [seed], logs: [] }));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: seed, method: "email" }));
}, USER);
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(3000);

// Reach Clock In / Out the way an employee does.
const quick = page.locator(".native.active .quick-action-row button", { hasText: "Clock" });
if (await quick.count()) await quick.first().click();
else await page.locator(".native.active .module-bubble", { hasText: "Time & Attendance" }).click();
await page.waitForTimeout(1600);

const punch = page.locator(".native.active button.clock-punch");
check("the clock button is on screen", await punch.count() === 1);

const label = async () => (await punch.textContent().catch(() => "")).trim();
const logCount = async () => page.evaluate(() => {
  try { return (JSON.parse(localStorage.getItem("larsaStaffV8") || "{}").logs || []).length; }
  catch { return -1; }
});

check("it starts on Clock In", (await label()).includes("Clock In"), await label());
check("with no attendance records yet", await logCount() === 0);

// ------------------------------------------------ 1. one press, and how fast
const t0 = Date.now();
await punch.click();
// Poll rather than sleep, so the number reported is the real time to update.
await page.waitForFunction(
  () => (document.querySelector(".native.active button.clock-punch")?.textContent || "").includes("Clock Out"),
  { timeout: 5000 },
).catch(() => {});
const elapsed = Date.now() - t0;

check("ONE press clocks in — no second click needed", (await label()).includes("Clock Out"), await label());
check("and it is written straight away", await logCount() === 1, String(await logCount()));
/* The bar is deliberately human rather than theoretical: anything under a
   fifth of a second reads as instant. The old build ran the engine's whole
   iframe re-render between the click and the repaint. */
check(`the button updates immediately (${elapsed}ms)`, elapsed < 400, `${elapsed}ms`);

// -------------------------------------- 2. a genuine double-fire is absorbed
const beforeDouble = await logCount();
await punch.click({ clickCount: 2, delay: 40 });
await page.waitForTimeout(600);
check("an accidental double-click does not open and close a zero-minute session",
  await logCount() === beforeDouble, `${beforeDouble} -> ${await logCount()}`);
check("and the button still reads Clock Out afterwards", (await label()).includes("Clock Out"), await label());

// ----------------------------- 3. a deliberate second press IS honoured
/* This is the regression that produced the complaint: the guard used to
   swallow ten seconds of presses and report success while doing nothing. */
await page.waitForTimeout(1400);
const t1 = Date.now();
await punch.click();
await page.waitForFunction(
  () => (document.querySelector(".native.active button.clock-punch")?.textContent || "").includes("Clock In"),
  { timeout: 5000 },
).catch(() => {});
const outElapsed = Date.now() - t1;

check("a deliberate clock-out is accepted on the FIRST press", (await label()).includes("Clock In"), await label());
check("and the record is written", await logCount() === beforeDouble + 1, String(await logCount()));
check(`clock-out also updates immediately (${outElapsed}ms)`, outElapsed < 400, `${outElapsed}ms`);

// ------------------------------------- 4. the pair is a real, ordered session
const pair = await page.evaluate(() => {
  const logs = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}").logs || [];
  return logs.map((l) => ({ status: l.status, time: l.time }));
});
check("the two records are an In then an Out, in that order",
  pair.length === 2 && pair[0].status === "In" && pair[1].status === "Out", JSON.stringify(pair));
check("with the clock-out after the clock-in",
  new Date(pair[1]?.time) > new Date(pair[0]?.time), JSON.stringify(pair));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length, passed: results.length - failed.length,
  failed: failed.map((f) => f.label),
  all: results.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.label}`),
}, null, 1));
process.exit(failed.length ? 1 : 0);
