/* Larsa Control — a two-stage approval chain, driven end to end.
 *
 * The source tests next door pin the rule. This one exercises it in the built
 * app with three real accounts and one real request, because the failure it
 * guards against was precisely that the recorded chain and the behaviour had
 * drifted apart while every unit-level assumption still looked fine.
 *
 *   node tests/approval-chain-e2e.smoke.mjs      # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";
const now = new Date().toISOString();
const device = { id: "dev-1", label: "smoke", firstSeen: now, lastSeen: now, lastVerified: now, lastAccountingVerified: now };

const EMPLOYEE = { id: "u-emp", name: "Noor Hassan", email: "noor@larsaeng.com", role: "Engineer", access: "Engineer", department: "Structural", enabled: true, active: true, emailVerified: true, devices: [device] };
const FIRST = { id: "u-lead", name: "Team Lead", email: "lead@larsaeng.com", role: "Team Lead", access: "Super Admin", department: "Structural", enabled: true, active: true, emailVerified: true, devices: [device] };
const SECOND = { id: "u-head", name: "Dept Head", email: "head@larsaeng.com", role: "Head", access: "Super Admin", department: "Structural", enabled: true, active: true, emailVerified: true, devices: [device] };

const REQUEST = {
  id: "r-chain-1", type: "Leave", uid: EMPLOYEE.id, requestType: "Annual",
  from: "2026-09-01", to: "2026-09-03", date: "2026-09-01", reason: "Family",
  status: "Pending", flow: [FIRST.id, SECOND.id], step: 0, history: [], createdAt: now,
};

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

/* Each act is a fresh context signed in as one person, reading and writing the
   same seeded store — which is how the real thing works across machines. */
async function asUser(user, store) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(([who, seeded]) => {
    localStorage.setItem("larsaDeviceId", "dev-1");
    localStorage.setItem("larsaStaffV8", JSON.stringify(seeded));
    sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: who, method: "email" }));
  }, [user, store]);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  return { context, page };
}

const readRequest = (page) => page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
  const row = (store.approvals || [])[0] || null;
  return row && { status: row.status, step: row.step, decidedBy: row.decidedBy || null, history: (row.history || []).map((h) => h.action) };
});

const openQueue = async (page) => {
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".module-bubble")].find((n) => (n.textContent || "").includes("Time & Attendance"));
    if (card) card.click();
  });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const link = [...document.querySelectorAll(".sidebar .nav-list a, .sidebar .nav-list button")].find((n) => (n.textContent || "").includes("Leave & Requests"));
    if (link) link.click();
  });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("button")].find((n) => /To approve/.test(n.textContent || ""));
    if (tab) tab.click();
  });
  await page.waitForTimeout(1000);
};

const seed = { users: [EMPLOYEE, FIRST, SECOND], logs: [], approvals: [REQUEST], performance: [] };

// ------------------------------------- 1. the second approver cannot go first
{
  const { context, page } = await asUser(SECOND, seed);
  await openQueue(page);
  const cell = await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    return row ? (row.querySelector(".review-actions")?.textContent || "").trim() : "no row";
  });
  /* Dept Head is a Super Admin here, which is the deliberate escape hatch, so
     the buttons are offered. What matters is that the step is named. */
  check("the queue tells the second approver where the request actually is",
    /step 1 of 2|With Team Lead/.test(cell) || cell.includes("Approve · next step"), cell);
  await context.close();
}

// ------------------------- 2. an ordinary approver out of turn is turned away
{
  const outsider = { ...SECOND, access: "Engineer", permissions: ["Approve Leave"] };
  const { context, page } = await asUser(outsider, { ...seed, users: [EMPLOYEE, FIRST, outsider] });
  await openQueue(page);
  const cell = await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    return row ? (row.querySelector(".review-actions")?.textContent || "").trim() : "no row";
  });
  check("an approver who is not next gets no button, just whose desk it is on",
    cell === "no row" || /With Team Lead/.test(cell), cell);
  await context.close();
}

// --------------------------------- 3. the first approver advances, not closes
let afterFirst = null;
{
  const { context, page } = await asUser(FIRST, seed);
  await openQueue(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    const button = row && [...row.querySelectorAll("button")].find((b) => /Approve/.test(b.textContent || ""));
    if (button) button.click();
  });
  await page.waitForTimeout(1200);
  afterFirst = await readRequest(page);
  check("approving at step 1 does NOT close the request", afterFirst?.status === "Pending", JSON.stringify(afterFirst));
  check("it moves to step 2", afterFirst?.step === 1, JSON.stringify(afterFirst));
  check("and nobody is recorded as having decided it yet", afterFirst?.decidedBy === null, JSON.stringify(afterFirst));
  check("the step is written into the history", /step 1 of 2/.test((afterFirst?.history || []).join("|")), JSON.stringify(afterFirst?.history));
  await context.close();
}

// ------------------------------------- 4. the second approver finishes it off
{
  const carried = { ...seed, approvals: [{ ...REQUEST, status: "Pending", step: 1, history: [{ by: FIRST.name, action: "Approved (step 1 of 2)", at: now }] }] };
  const { context, page } = await asUser(SECOND, carried);
  await openQueue(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    const button = row && [...row.querySelectorAll("button")].find((b) => /Approve/.test(b.textContent || ""));
    if (button) button.click();
  });
  await page.waitForTimeout(1200);
  const final = await readRequest(page);
  check("approving at the last step DOES close the request", final?.status === "Approved", JSON.stringify(final));
  check("and now it has a decider", final?.decidedBy === SECOND.name, JSON.stringify(final));
  await context.close();
}

// --------------------------------- 5. a rejection at step 1 ends it outright
{
  const { context, page } = await asUser(FIRST, seed);
  page.on("dialog", (d) => d.accept("Not this month"));
  await openQueue(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    const button = row && [...row.querySelectorAll("button")].find((b) => /Reject/.test(b.textContent || ""));
    if (button) button.click();
  });
  await page.waitForTimeout(1200);
  const rejected = await readRequest(page);
  check("one approver can stop a request without the rest of the chain", rejected?.status === "Rejected", JSON.stringify(rejected));
  await context.close();
}

// ------------------------------ 6. a request with no chain still works at all
{
  const legacy = { ...seed, approvals: [{ ...REQUEST, id: "r-legacy", flow: undefined, step: undefined }] };
  const { context, page } = await asUser(FIRST, legacy);
  await openQueue(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("tbody tr")].find((n) => (n.textContent || "").includes("Noor Hassan"));
    const button = row && [...row.querySelectorAll("button")].find((b) => /Approve/.test(b.textContent || ""));
    if (button) button.click();
  });
  await page.waitForTimeout(1200);
  const legacyResult = await readRequest(page);
  check("an older request with no chain is decided in one step, as before",
    legacyResult?.status === "Approved", JSON.stringify(legacyResult));
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length, passed: results.length - failed.length,
  failed: failed.map((f) => `${f.label} — ${f.detail}`),
  all: results.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.label}`),
}, null, 1));
process.exit(failed.length ? 1 : 0);
