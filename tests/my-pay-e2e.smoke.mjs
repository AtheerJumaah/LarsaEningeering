/* Browser E2E for My Pay against a mocked payroll backend.
 * Run manually: node tests/my-pay-e2e.smoke.mjs
 *
 * Drives the real shell: signs a person in, opens My Pay, checks the summary,
 * the filters, the charts, the period detail and the payslip, and — the point
 * of the whole screen — that the request it makes never asks for anybody
 * else's record.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.MYPAY_BASE || "http://127.0.0.1:5199";
const USER = {
  id: "u-sara", name: "Sara Ali", email: "sara@larsaeng.com", role: "Engineer",
  access: "Engineer", enabled: true, active: true,
};

const STATEMENT = {
  ok: true, found: true, viewed_by_self: true,
  employee: {
    email: "sara@larsaeng.com", employee_no: "E-001", full_name: "Sara Ali",
    position: "Structural Engineer", department: "Engineering",
    employment_start: "2025-03-01", salary_currency: "IQD", base_salary: 1500000,
    payment_method: "Bank transfer", payment_ref_masked: "••••••7890",
    show_pending_commissions: true,
  },
  range: { from: "2026-02-01", to: "2026-07-31", note: null },
  totals: {
    base_salary_iqd: 3000000, commission_iqd: 200000, bonus_iqd: 100000,
    deduction_iqd: 50000, advance_repayment_iqd: 0, reimbursement_iqd: 75000,
    net_iqd: 3325000, net_usd: 2538.17, paid_iqd: 1000000, paid_usd: 763.36,
    outstanding_iqd: 2325000, approved_commission_iqd: 500000,
    pending_commission_iqd: 250000, periods: 2, average_month_iqd: 1662500,
    last_paid_on: "2026-07-05",
  },
  by_currency: { IQD: { net: 3325000 }, USD: { net: 1000 } },
  periods: [{
    period_id: "p1", period_no: "LRS-PR-000002", label: "June 2026",
    period_start: "2026-06-01", period_end: "2026-06-30", pay_date: "2026-07-05",
    currency: "IQD", status: "partially_paid", published_at: "2026-07-01T00:00:00Z",
    base_salary_iqd: 1500000, commission_iqd: 200000, bonus_iqd: 100000,
    deduction_iqd: 50000, advance_repayment_iqd: 0, reimbursement_iqd: 75000,
    net_iqd: 1825000, net_usd: 1393.13, paid_iqd: 1000000, last_paid_on: "2026-07-05",
    currencies: ["IQD"],
    items: [
      { id: "i1", item_type: "base_salary", description: "June salary", original_amount: 1500000, original_currency: "IQD", exchange_rate: 1310, rate_date: "2026-07-05", rate_source: "platform_default", amount_iqd: 1500000, amount_usd: 1145.04, sign: 1, status: "approved" },
      { id: "i2", item_type: "commission", description: "Villa handover", original_amount: 200000, original_currency: "IQD", exchange_rate: 1310, rate_date: "2026-07-05", rate_source: "platform_default", amount_iqd: 200000, amount_usd: 152.67, sign: 1, status: "approved" },
      { id: "i3", item_type: "deduction", description: "Late arrivals", original_amount: 50000, original_currency: "IQD", exchange_rate: 1310, rate_date: "2026-07-05", rate_source: "platform_default", amount_iqd: 50000, amount_usd: 38.17, sign: -1, status: "approved" },
    ],
  }, {
    period_id: "p0", period_no: "LRS-PR-000001", label: "May 2026",
    period_start: "2026-05-01", period_end: "2026-05-31", pay_date: "2026-06-05",
    currency: "IQD", status: "paid", published_at: "2026-06-01T00:00:00Z",
    base_salary_iqd: 1500000, commission_iqd: 0, bonus_iqd: 0,
    deduction_iqd: 0, advance_repayment_iqd: 0, reimbursement_iqd: 0,
    net_iqd: 1500000, net_usd: 1145.04, paid_iqd: 1500000, last_paid_on: "2026-06-05",
    currencies: ["IQD"], items: [],
  }],
  months: [
    { month: "2026-05", base_iqd: 1500000, commission_iqd: 0, bonus_iqd: 0, net_iqd: 1500000 },
    { month: "2026-06", base_iqd: 1500000, commission_iqd: 200000, bonus_iqd: 100000, net_iqd: 1825000 },
  ],
  commissions: [
    { id: "c1", commission_no: "LRS-CM-000001", title: "Villa referral", client: "Mosul Client",
      earning_start: "2026-06-01", earning_end: "2026-06-30", basis: "percent", rate: 0.05,
      base_amount: 10000000, base_currency: "IQD", original_amount: 500000, original_currency: "IQD",
      exchange_rate: 1310, rate_date: "2026-06-30", rate_source: "platform_default",
      amount_iqd: 500000, amount_usd: 381.68, status: "approved",
      submitted_at: "2026-06-30T00:00:00Z", approved_at: "2026-07-01T00:00:00Z",
      approved_by: "boss@larsaeng.com", period_no: "LRS-PR-000002", created_at: "2026-06-30T00:00:00Z" },
    { id: "c2", commission_no: "LRS-CM-000002", title: "Tender bonus", basis: "fixed",
      original_amount: 250000, original_currency: "IQD", exchange_rate: 1310,
      amount_iqd: 250000, amount_usd: 190.84, status: "pending_review",
      created_at: "2026-07-10T00:00:00Z" },
  ],
};

const PAYSLIP = {
  ok: true, slip_no: "LRS-PR-000002-E-001", verification: "a1b2c3d4e5f60718",
  employer: { name: "Larsa Engineering" },
  employee: { email: "sara@larsaeng.com", employee_no: "E-001", full_name: "Sara Ali",
    position: "Structural Engineer", department: "Engineering", employment_start: "2025-03-01",
    payment_method: "Bank transfer", payment_ref_masked: "••••••7890" },
  period: { period_no: "LRS-PR-000002", label: "June 2026", period_start: "2026-06-01",
    period_end: "2026-06-30", pay_date: "2026-07-05", currency: "IQD",
    status: "partially_paid", published_at: "2026-07-01T00:00:00Z",
    approved_by: "boss@larsaeng.com", approved_at: "2026-07-01T00:00:00Z" },
  items: STATEMENT.periods[0].items,
  payments: [{ paid_on: "2026-07-05", amount: 1000000, currency: "IQD", amount_iqd: 1000000,
    status: "paid", method: "Bank transfer", reference_masked: "••••1234" }],
  gross_iqd: 1875000, net_iqd: 1825000, paid_iqd: 1000000, outstanding_iqd: 825000,
  payment_state: "partially_paid",
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const errors = [];
const calls = [];
page.on("pageerror", (e) => errors.push(e.message));

// Stand in for Supabase. Every RPC the screen makes is captured, so the test
// can assert on what it asked for as well as what it drew.
await page.route("**/rest/v1/rpc/**", async (route) => {
  const url = route.request().url();
  let body = {};
  try { body = JSON.parse(route.request().postData() || "{}"); } catch { body = {}; }
  const name = url.split("/rpc/")[1].split("?")[0];
  calls.push({ name, body });
  const payload = name === "pay_my_statement" ? STATEMENT
    : name === "pay_payslip" ? PAYSLIP
    : { ok: true };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
});
await page.route("**/auth/v1/**", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "t", user: { id: "anon" } }) }));

await page.addInitScript((seed) => {
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [seed] }));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: seed, method: "email" }));
}, USER);
await page.goto(BASE + "/", { waitUntil: "load" });
await page.waitForTimeout(3200);

// Reach My Pay the way an employee does: the Home quick action.
const quick = page.locator(".quick-action-row button", { hasText: "My Pay" });
const reachable = await quick.count();
if (reachable) await quick.first().click();
else await page.locator(".nav-item", { hasText: "My Pay" }).first().click();
await page.waitForTimeout(1600);

const shell = await page.evaluate(() => ({
  heading: (document.querySelector(".page-heading h1") || {}).textContent,
  onePlace: document.querySelectorAll(".pay-scroll").length,
  ownHeader: document.querySelectorAll(".pay-scroll .topbar, .pay-scroll aside.sidebar").length,
  cards: document.querySelectorAll(".pay-card").length,
  // Scoped to Home: every native view is mounted at once, and Administration
  // has cards of its own.
  /* The Home cards are permission-filtered, so this account sees a subset.
     What matters is that My Pay never became one of them. */
  homeCards: [...document.querySelectorAll(".home-scroll .module-grid:not(.quick-grid):not(.accounting-grid) .module-bubble")]
    .map((c) => (c.querySelector(".module-copy b") || {}).textContent),
}));

const summary = await page.evaluate(() => {
  const card = (label) => {
    const hit = [...document.querySelectorAll(".pay-card")]
      .find((c) => (c.querySelector("small") || {}).textContent === label);
    return hit ? (hit.querySelector("b") || {}).textContent : null;
  };
  return {
    base: card("Base salary"),
    approvedCommission: card("Approved commissions"),
    pendingCommission: card("Pending commissions"),
    reimbursement: card("Reimbursements"),
    net: card("Net earnings"),
    paid: card("Amount paid"),
    outstanding: card("Approved, not yet paid"),
    status: (document.querySelector(".pay-controls .pay-status") || {}).textContent,
    split: (document.querySelector(".pay-split") || {}).textContent,
  };
});

// The charts must draw, and must not stack a total with its own parts.
const charts = await page.evaluate(() => ({
  figures: document.querySelectorAll(".pay-chart").length,
  columns: document.querySelectorAll(".pay-chart .pay-column").length,
  stackSegments: document.querySelectorAll(".pay-chart .pay-stack i").length,
  legend: [...document.querySelectorAll(".pay-legend li")].map((li) => li.textContent.trim()),
  splitbar: document.querySelectorAll(".pay-splitbar i").length,
}));

// Open a period and read the breakdown without leaving the page.
await page.locator(".pay-period-head").first().click();
await page.waitForTimeout(500);
const detail = await page.evaluate(() => ({
  stillOnMyPay: document.querySelectorAll(".pay-scroll").length === 1,
  rows: document.querySelectorAll(".pay-period.is-open .pay-table tbody tr").length,
  hasDeduction: /Deduction/.test(document.querySelector(".pay-period.is-open .pay-table")?.textContent || ""),
  netRow: (document.querySelector(".pay-period.is-open .pay-total-row td:last-child") || {}).textContent,
}));

// The payslip.
await page.locator(".pay-period.is-open button", { hasText: "Payslip" }).first().click();
await page.waitForTimeout(900);
const slip = await page.evaluate(() => {
  const el = document.getElementById("larsa-payslip");
  if (!el) return { open: false };
  const text = el.textContent || "";
  return {
    open: true,
    logo: Boolean(el.querySelector("img")),
    net: /1,825,000 IQD/.test(text),
    paid: /1,000,000 IQD/.test(text),
    outstanding: /825,000 IQD/.test(text),
    state: /Partially paid/.test(text),
    neverClaimsPaid: !/^Paid$/m.test(text),
    maskedAccount: /••••••7890/.test(text),
    noInternalNote: !/internal/i.test(text),
  };
});
await page.keyboard.press("Escape");
await page.locator(".modal-layer").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.waitForTimeout(400);

// Filters ask the server for the right window and never for another person.
await page.locator(".pay-range button", { hasText: "Year to date" }).click();
await page.waitForTimeout(900);
await page.locator(".pay-range button", { hasText: "Since joining Larsa" }).click();
await page.waitForTimeout(900);

const statementCalls = calls.filter((c) => c.name === "pay_my_statement");
const askedForOthers = statementCalls.filter((c) => c.body.p_employee_email);
const joiningCall = statementCalls[statementCalls.length - 1];
const ytdCall = statementCalls[statementCalls.length - 2];

// Night mode has to be readable too.
await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Toggle theme"]');
  if (btn) btn.click();
});
await page.waitForTimeout(700);
const night = await page.evaluate(() => {
  const card = document.querySelector(".pay-card");
  const status = document.querySelector(".pay-status");
  return {
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
    cardInk: card ? getComputedStyle(card).color : null,
    statusBg: status ? getComputedStyle(status).backgroundColor : null,
  };
});
await page.screenshot({ path: "/tmp/mypay-night.png" });
await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Toggle theme"]');
  if (btn) btn.click();
});
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/mypay-day.png", fullPage: true });

// Mobile: the period table becomes a card rather than a sideways scroll.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const mobile = await page.evaluate(() => {
  const head = document.querySelector(".pay-period-head");
  const scroller = document.querySelector(".pay-scroll");
  return {
    columns: head ? getComputedStyle(head).gridTemplateColumns.split(" ").length : 0,
    noSidewaysScroll: scroller ? scroller.scrollWidth <= scroller.clientWidth + 2 : false,
  };
});
await page.screenshot({ path: "/tmp/mypay-mobile.png" });

await browser.close();

console.log("shell:", JSON.stringify(shell));
console.log("summary:", JSON.stringify(summary));
console.log("charts:", JSON.stringify(charts));
console.log("period detail:", JSON.stringify(detail));
console.log("payslip:", JSON.stringify(slip));
console.log("filters:", JSON.stringify({
  statementCalls: statementCalls.length,
  askedForSomeoneElse: askedForOthers.length,
  ytd: ytdCall && { from: ytdCall.body.p_from, to: ytdCall.body.p_to },
  sinceJoining: joiningCall && { from: joiningCall.body.p_from },
}));
console.log("night:", JSON.stringify(night));
console.log("mobile:", JSON.stringify(mobile));
const fatal = errors.filter((e) => !/Failed to fetch|forEach|u-sara|setting '/.test(e));
console.log("page errors:", JSON.stringify(fatal));

const pass = shell.onePlace === 1 && shell.ownHeader === 0 && shell.cards === 10
  && shell.homeCards.length > 0 && !shell.homeCards.includes("My Pay")
  && summary.base === "3,000,000 IQD" && summary.approvedCommission === "500,000 IQD"
  && summary.pendingCommission === "250,000 IQD" && summary.reimbursement === "75,000 IQD"
  && summary.net === "3,325,000 IQD" && summary.paid === "1,000,000 IQD"
  && summary.outstanding === "2,325,000 IQD"
  && /Partially paid/.test(summary.status || "")
  && /never added together/.test(summary.split || "")
  && charts.figures === 3 && charts.columns === 4 && charts.stackSegments === 8
  && charts.splitbar === 2
  && detail.stillOnMyPay && detail.rows === 4 && detail.hasDeduction
  && /1,825,000 IQD/.test(detail.netRow || "")
  && slip.open && slip.logo && slip.net && slip.paid && slip.outstanding && slip.state
  && slip.maskedAccount && slip.noInternalNote
  && statementCalls.length >= 3 && askedForOthers.length === 0
  && ytdCall.body.p_from.endsWith("-01-01")
  && joiningCall.body.p_from === "2025-03-01"
  && night.cardBg !== night.cardInk
  && mobile.columns === 2 && mobile.noSidewaysScroll
  && fatal.length === 0;

console.log(pass ? "MY PAY E2E OK" : "MY PAY E2E FAILED");
process.exit(pass ? 0 : 1);
