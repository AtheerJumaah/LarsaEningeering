/* Browser E2E smoke for the accounting layer against a mocked Supabase.
 * Run with node tests/accounting-e2e.smoke.mjs. Optional environment variables
 * PLAYWRIGHT_MODULE and CHROME_PATH select an installed runner and browser. */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const runtimePlaywright = join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime",
  "dependencies", "node", "node_modules", "playwright");
const playwrightModule = process.env.PLAYWRIGHT_MODULE
  || [runtimePlaywright, "/home/claude/.npm-global/lib/node_modules/playwright"].find(existsSync)
  || "playwright";
const { chromium } = require(playwrightModule);
const chrome = process.env.CHROME_PATH || [
  join(process.env.ProgramFiles || "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  "/opt/pw-browsers/chromium",
].find(existsSync);
const origin = "http://larsa-accounting.test";
const calls = [];
const PROJECT = { id: "prj1", name: "E2E Villa", currency: "IQD", fee_inherit: true, approved_budget: 100000000, budget_currency: "IQD", contract_value: 150000000, is_sample: false, created_at: "2026-01-01" };
const TXN = { id: "11111111-1111-4111-8111-111111111111", review_status: "pending_review", txn_no: "LRS-TXN-000001", project_id: "prj1", kind: "funding", category: "Client Funding", description: "First funding", txn_date: "2026-01-10", status: "received", original_amount: 10000000, original_currency: "IQD", exchange_rate: 1310, rate_source: "platform_default", amount_iqd: 10000000, amount_usd: 7633.59, fee_rule: { method: "percentage", rate: 0.08, basis: "funding", treatment: "deduct_from_funding", source: "platform_default" }, is_sample: false, meta: {}, created_at: "2026-01-10" };
const FEE = { id: "22222222-2222-4222-8222-222222222222", project_id: "prj1", source_txn_id: TXN.id, entry_type: "fee", calc_method: "percentage", fee_rate: 0.08, calc_basis: "funding", basis_amount: 10000000, fee_amount: 800000, currency: "IQD", exchange_rate: 1310, fee_iqd: 800000, fee_usd: 610.69, treatment: "deduct_from_funding", config_source: "platform_default", status: "posted", provisional: true, is_sample: false, created_at: "2026-01-10" };
const RECEIPT = { id: "44444444-4444-4444-8444-444444444444", receipt_no: "LRS-RCP-000001", txn_id: TXN.id, project_id: "prj1", kind: "original", version: 1, status_at_issue: "pending_review", created_at: "2026-01-10",
  snapshot: { receipt_no: "LRS-RCP-000001", txn_no: TXN.txn_no, project_id: "prj1", project_code: "E2E", project_name: "E2E Villa", payer_name: "Client X", amount: 10000000, currency: "IQD", amount_iqd: 10000000, amount_usd: 7633.59, exchange_rate: 1310, txn_date: "2026-01-10", payment_method: "Cash", fee_rate: 0.08, fee_amount: 800000, fee_treatment: "deduct_from_funding", net_after_fee: 9200000, received_by: "Site Office", entered_by_name: "E2E Accountant", review_status_at_issue: "pending_review", verify_code: "ABC123", timezone: "Asia/Baghdad", issued_at: "2026-01-10T10:00:00Z" } };
const bootstrap = {
  settings: { default_exchange_rate: 1450, default_fee_method: "percentage", default_fee_rate: 0.08, default_fee_basis: "funding", default_fee_treatment: "deduct_from_funding", sample_state: "removed" },
  projects: [PROJECT], transactions: [TXN], fee_ledger: [FEE], refund_settlements: [], receipts: [RECEIPT], permissions: [],
  progress: [{ id: "p", project_id: "prj1", percent: 45, update_date: "2026-03-10", updated_by_name: "Site Eng", created_at: "x" }],
  approvals: [], review_queue: [], audit_recent: [], archives: [],
};

/* The authoritative model, shaped exactly like the production
   "Mosul Private Villa" figures the corrective pass must reproduce. */
const COMPANY_FIN = {
  projects: 1,
  client_funds: {
    gross_funding_iqd: 12000000, initial_fee_iqd: 960000, net_construction_funding_iqd: 11040000,
    construction_cost_approved_iqd: 7000000, construction_cost_working_iqd: 7400000,
    pending_construction_cost_iqd: 400000,
    remaining_balance_approved_iqd: 4040000, remaining_balance_working_iqd: 3640000,
    total_refund_due_iqd: 0, gross_funding_usd: 9160.31, initial_fee_usd: 732.82,
    net_construction_funding_usd: 8427.48, construction_cost_approved_usd: 5343.51,
    construction_cost_working_usd: 5648.85, remaining_balance_approved_usd: 3083.97,
    remaining_balance_working_usd: 2778.63,
  },
  company: {
    consultancy_fee_revenue_iqd: 960000, engineering_revenue_iqd: 0, other_revenue_iqd: 0,
    larsa_revenue_iqd: 960000, company_expenses_iqd: 0, fee_refunds_reversals_iqd: 0,
    company_net_profit_iqd: 960000, net_margin_pct: 100,
    consultancy_fee_revenue_usd: 732.82, engineering_revenue_usd: 0, other_revenue_usd: 0,
    company_expenses_usd: 0, larsa_revenue_usd: 732.82, company_net_profit_usd: 732.82,
  },
  by_currency: { IQD: { currency: "IQD", gross_funding_working: 12000000, construction_cost_working: 7400000, entries: 6 } },
  review: { status: "yellow", unapproved_entries: 1, needs_correction_entries: 0, label: "Contains 1 unapproved entry" },
  rows: [{
    project_id: "prj1", project_name: "E2E Villa", project_code: "E2E", client: "Client X", region: "Iraq",
    currency: "IQD", is_sample: false, accounting_mode: "client_funded",
    contract_value: 150000000, approved_budget: 100000000, budget_currency: "IQD",
    by_currency: { IQD: { currency: "IQD", gross_funding_working: 12000000, construction_cost_working: 7400000, entries: 6 } },
    fee: { effective_rate: 0.08, effective_rate_pct: 8, source: "platform_default", basis: "funding",
      treatment: "deduct_from_funding", initial_accrued_iqd: 960000, is_final: false, final_settled_iqd: null },
    client_funds: {
      approved: {
        gross_funding_iqd: 12000000, gross_funding_usd: 9160.31,
        initial_fee_iqd: 960000, initial_fee_usd: 732.82,
        net_construction_funding_iqd: 11040000, net_construction_funding_usd: 8427.48,
        materials_iqd: 3000000, materials_usd: 2290.08,
        labor_iqd: 2500000, labor_usd: 1908.4,
        other_costs_iqd: 1500000, other_costs_usd: 1145.04,
        construction_cost_iqd: 7000000, construction_cost_usd: 5343.51,
        total_used_iqd: 7960000, total_used_usd: 6076.34,
        remaining_balance_iqd: 4040000, remaining_balance_usd: 3083.97,
      },
      working: {
        gross_funding_iqd: 12000000, gross_funding_usd: 9160.31,
        materials_iqd: 3000000, materials_usd: 2290.08,
        labor_iqd: 2500000, labor_usd: 1908.4,
        other_costs_iqd: 1900000, other_costs_usd: 1450.38,
        construction_cost_iqd: 7400000, construction_cost_usd: 5648.85,
        total_used_iqd: 8360000, total_used_usd: 6381.68,
        remaining_balance_iqd: 3640000, remaining_balance_usd: 2778.63,
      },
      pending: { construction_cost_iqd: 400000, construction_cost_usd: 305.34, gross_funding_iqd: 0, entries: 1 },
      refundable_principal_iqd: 4040000, refundable_fee_iqd: 323200,
      total_refund_due_iqd: 4363200, refunded_principal_to_date_iqd: 0, adjustments_iqd: 0,
    },
    company: {
      consultancy_fee_revenue_iqd: 960000, consultancy_fee_revenue_usd: 732.82,
      engineering_revenue_iqd: 0, engineering_revenue_usd: 0,
      other_revenue_iqd: 0, other_revenue_usd: 0,
      larsa_revenue_iqd: 960000, larsa_revenue_usd: 732.82,
      operating_expenses_iqd: 0, operating_expenses_usd: 0,
      larsa_attributable_project_costs_iqd: 0,
      company_expenses_iqd: 0, company_expenses_usd: 0,
      fee_refunds_reversals_iqd: 0,
      company_net_profit_iqd: 960000, company_net_profit_usd: 732.82,
    },
    review: { status: "yellow", unapproved_entries: 1, needs_correction_entries: 0, label: "Contains 1 unapproved entry" },
    cost_progress_pct: 7, schedule_progress_pct: 45,
    schedule_progress_date: "2026-03-10", schedule_progress_by: "Site Eng",
  }],
};

function rpcResponse(name, body) {
  if (name === "acct_get_bootstrap") return bootstrap;
  if (name === "acct_company_financials") return COMPANY_FIN;
  if (name === "acct_approval_queue") return { total: 1, by_kind: { expense: 1 }, rows: [
    { id: "aa", queue_type: "transaction", record_kind: "expense", reference: "LRS-TXN-000009", project_id: "prj1",
      project_name: "E2E Villa", description: "Pending permit", amount: 400000, currency: "IQD",
      entered_by: "e2e@larsaeng.com", entered_by_name: "E2E Accountant", assigned_approver: "Any authorised approver",
      age_days: 3, action: "approve_entry", action_label: "Approve so it counts", payment_status: "pending" },
  ] };
  if (name === "acct_audit_page") return { total: 2, actions: ["Funding Added"], rows: [
    { id: 2, at: "2026-03-11T09:00:00Z", actor_email: "e2e@larsaeng.com", actor_name: "E2E Accountant",
      actor_role: "Accountant", project_id: "prj1", record_type: "funding", record_id: "x",
      action: "Funding Added", reason: null, details: "LRS-TXN-000001", changed_fields: [] },
  ] };
  if (name === "acct_is_platform_admin") return false;
  if (name === "acct_get_my_permissions") return { view: true, create: true, submit_review: true, print_receipts: true,
    reprint_receipts: true, approve: false, reject: false, export_working: true, edit_own_unapproved: true };
  if (name === "acct_post_transaction") {
    const txnId = "33333333-3333-4333-8333-333333333333";
    const txnDate = body.txn.date;
    return { ok: true, txn: { ...TXN, id: txnId, txn_no: "LRS-TXN-000002", txn_date: txnDate },
      fee: { fee_amount: 160000, currency: "IQD", status: "posted" },
      receipt: { ...RECEIPT, id: "55555555-5555-4555-8555-555555555555", receipt_no: "LRS-RCP-000002", txn_id: txnId,
        snapshot: { ...RECEIPT.snapshot, receipt_no: "LRS-RCP-000002", amount: 2000000, amount_iqd: 2000000, txn_date: txnDate } } };
  }
  return { ok: true };
}

const browser = await chromium.launch({ executablePath: chrome });
const ctx = await browser.newContext({ serviceWorkers: "block" });
const firstFinancialRequest = Promise.withResolvers();
const releaseFinancials = Promise.withResolvers();
const assets = new Map([
  ["/engines/accounting.html", "text/html; charset=utf-8"],
  ["/engines/accounting-core.js", "text/javascript; charset=utf-8"],
  ["/engines/accounting-cloud.js", "text/javascript; charset=utf-8"],
]);
await ctx.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  const prefix = "/rest/v1/rpc/";
  if (url.pathname.startsWith(prefix)) {
    const name = url.pathname.slice(prefix.length);
    const body = route.request().postDataJSON();
    calls.push({ name, body });
    if (name === "acct_company_financials") {
      firstFinancialRequest.resolve();
      await releaseFinancials.promise;
    }
    return route.fulfill({ json: rpcResponse(name, body) });
  }
  const contentType = assets.get(url.pathname);
  if (!contentType) return route.fulfill({ status: 404 });
  const path = new URL("../public" + url.pathname, import.meta.url);
  return route.fulfill({ contentType, body: readFileSync(path) });
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript((url) => {
  localStorage.setItem("larsaSupabaseBridgeV1", JSON.stringify({ url, anonKey: "test-anon" }));
  // The roster the parent shell normally injects, so the people dropdowns
  // have real accounts to offer.
  window.__larsaAccountingRoster = [
    { email: "e2e@larsaeng.com", name: "E2E Accountant", role: "Accountant" },
    { email: "boss@larsaeng.com", name: "E2E Approver", role: "Approver" },
  ];
}, origin);
await page.goto(origin + "/engines/accounting.html?demo=1", { waitUntil: "load" });
await Promise.race([
  firstFinancialRequest.promise,
  page.waitForTimeout(5000).then(() => { throw new Error("The first financial RPC was never requested."); }),
]);

// Sign a writer in, the way the parent shell does (lexical global assignment).
await page.evaluate(`
  currentUser = { id: "u1", name: "E2E Accountant", email: "e2e@larsaeng.com", role: "Accountant", active: true };
  var app = document.getElementById("app"); if (app) app.style.display = "flex";
  var login = document.getElementById("loginScreen"); if (login) login.style.display = "none";
  window.__accountingObservedRevenue = [];
  var renderBeforeFinancials = window.render;
  window.render = function() {
    var summary = totals();
    window.__accountingObservedRevenue.push(summary._authoritative ? summary.realRevenue : null);
    return renderBeforeFinancials.apply(this, arguments);
  };
`);
releaseFinancials.resolve();
await page.waitForFunction(() => window.__accountingObservedRevenue.some((value) => value !== null), null, { timeout: 5000 });
const companyTotals = await page.evaluate(() => {
  const { fees, realRevenue, net, fundingGross, fundsHeld, fundsHeldWorking } = totals();
  return { fees, realRevenue, net, fundingGross, fundsHeld, fundsHeldWorking };
});
assert.deepEqual(companyTotals, {
  fees: 732.82, realRevenue: 732.82, net: 732.82,
  fundingGross: 9160.31, fundsHeld: 3083.97, fundsHeldWorking: 2778.63,
}, "company totals use historical currency snapshots even when today's default rate differs");
console.log("delayed authoritative totals and historical USD snapshots:", JSON.stringify(companyTotals));

const mirror = await page.evaluate(() => ({
  on: window.ACCT && window.ACCT.on,
  fundingCount: state.funding.length,
  fundingFee: state.funding[0] && state.funding[0].consultancyFee,
  fundingNet: state.funding[0] && state.funding[0].netConstruction,
  managed: state.funding[0] && state.funding[0]._acctManaged === true,
  fundingDate: state.funding[0] && state.funding[0].date,
  fxRate: state.funding[0] && state.funding[0].fxRate,
  projBudget: (state.projects.find(p => p.id === "prj1") || {}).approvedBudget,
}));
console.log("mirror:", JSON.stringify(mirror));

// The portfolio totals come from the same working/approved snapshots as the project.
await page.evaluate(() => showSection("reports"));
const portfolio = await page.locator("#acct_reports_flag").innerText();
for (const figure of ["12,000,000", "960,000", "7,400,000", "8,360,000", "3,640,000"]) {
  assert.ok(portfolio.includes(figure), "portfolio is missing the authoritative figure " + figure);
}
assert.match(portfolio, /Refund Due \(approved basis\)/i);
console.log("portfolio working totals and approved refund basis verified");

const monthly = await page.evaluate(() => {
  const date = "2026-01-10";
  const fixture = {
    funding: [{ projectId: "prj1", date, status: "Received", amount: 100, consultancyFee: 10, currency: "USD", fxRate: 1500 }],
    revenue: [
      { projectId: "prj1", date, status: "Received", amount: 1500000, currency: "IQD", fxRate: 1500 },
      { date, status: "Received", amount: 1600000, currency: "IQD", fxRate: 1600 },
    ],
    expenses: [
      { projectId: "prj1", date, status: "Paid", amount: 40, currency: "USD", fxRate: 1500, paymentSource: "Client Funding" },
      { projectId: "prj1", date, status: "Paid", amount: 30000, currency: "IQD", fxRate: 1500, paymentSource: "Larsa Operating" },
    ],
    materials: [], projectLabor: [],
    operating: [{ date, status: "Paid", amount: 320000, currency: "IQD", fxRate: 1600 }],
    payroll: [
      { id: "pay-1", employeeId: "employee-1", payDate: date, status: "Paid", totalCompanyCost: 150000, currency: "IQD", fxRate: 1500 },
      { id: "pay-2", employeeId: "employee-1", payDate: date, status: "Paid", totalCompanyCost: 0, grossPay: 250, currency: "USD" },
      { id: "pay-3", employeeId: "employee-1", payDate: date, status: "Reversed", totalCompanyCost: 300, currency: "USD" },
      { id: "pay-4", employeeId: "employee-1", payDate: date, status: "Paid", totalCompanyCost: 50, currency: "USD", fxRate: 1600 },
    ],
    commissions: [{ date, status: "Paid", due: 25 }, { date, status: "Reversed", due: 300 }],
  };
  const saved = Object.fromEntries(Object.keys(fixture).map((name) => [name, state[name]]));
  const originalPrint = window.printDoc;
  try {
    Object.assign(state, fixture);
    let printed = "";
    window.printDoc = (_title, content) => { printed = content; };
    x33PayrollStatement("pay-1", "all", { currency: "both" });
    const statement = document.createElement("div");
    statement.innerHTML = printed;
    const company = v35Series("all", "2026-01", "2026-01");
    const payroll = v35PayrollSeries("2026-01", "2026-01");
    const projectIqd = v35ProjectLikeSeries(id => id === "prj1", "2026-01", "2026-01", "IQD");
    return {
      revenue: company.revenue[0].value, cost: company.costs[0].value, net: company.net[0].value,
      salaries: payroll.salaries[0].value, commissions: payroll.commissions[0].value, payroll: payroll.totals[0].value,
      statementCost: statement.querySelector("tr.tot:last-child td.r")?.textContent,
      statementShowsReversal: statement.textContent.includes("Reversed"),
      projectSpendIqd: projectIqd.total[0].value,
      projectNetIqd: projectIqd.net[0].value,
    };
  } finally {
    Object.assign(state, saved);
    window.printDoc = originalPrint;
  }
});
assert.deepEqual(monthly, {
  revenue: 2010, cost: 375, net: 1635, salaries: 150, commissions: 25, payroll: 175,
  statementCost: "$150 / 230,000 IQD", statementShowsReversal: true,
  projectSpendIqd: 90000, projectNetIqd: 1485000,
});
await page.evaluate(() => showSection("funding"));
assert.equal(await page.getByRole("heading", { name: /Construction Financial Trend.*All Projects/ }).count(), 1);
await page.evaluate(() => showSection("payroll"));
assert.equal(await page.getByRole("heading", { name: "Payroll & Commission Trend" }).count(), 1);
console.log("monthly trends retain historical rates and exclude reversals; funding/payroll each render one chart block");

// Open the project detail and confirm the §4 summary card injects.
await page.evaluate(() => {
  showSection("projects");
  openProjectDetail("prj1", "summary");
});
await page.waitForTimeout(700);
assert.equal(await page.getByRole("heading", { name: "Financial Trend", exact: true }).count(), 1);
const summary = await page.evaluate(() => {
  const el = document.getElementById("acct_summary_card");
  return el ? el.textContent : null;
});
const hasSummary = !!summary;
/* The card now renders the authoritative backend model: the two separated
   blocks, and approved beside working. */
const summaryChecks = hasSummary && [
  "Contract Value", "Net Construction Funding", "Total Refund Due to Client", "Cost Progress",
  "Client Fund Control", "Larsa Company Accounting",
  "Approved Actual Cost", "Pending / Unapproved Cost", "Working Actual Cost",
  "Approved Remaining Client Balance", "Working Remaining Client Balance",
  "Larsa Revenue", "Company Net Profit",
].every((t) => summary.includes(t));
/* Opening a project gives the whole project: every ledger you can record
   into, with its own Add button, on the one page. */
const workspace = await page.evaluate(() => {
  const el = document.getElementById("acct_workspace");
  if (!el) return null;
  const page_ = document.getElementById("view");
  const addButtons = Array.from(page_.querySelectorAll("button"))
    .map((b) => (b.getAttribute("onclick") || ""))
    .filter((a) => a.includes("acctAddHere"));
  const cards = Array.from(page_.querySelectorAll(".acct-ws-card h3")).map((h) => h.textContent.trim());
  return { quickBar: el.textContent, addButtons, cards };
});
const workspaceOk = !!workspace
  && workspace.quickBar.includes("Record in this project")
  // every kind can be added without leaving the page
  && ["funding", "materials", "projectLabor", "expenses", "revenue"]
       .every((c) => workspace.addButtons.some((a) => a.includes("'" + c + "'")))
  // and every ledger is shown inline
  && ["Funding received", "Materials", "Workforce / Labour", "Other costs", "Revenue"]
       .every((n) => workspace.cards.some((c) => c.startsWith(n)));
console.log("project workspace:", workspaceOk,
  workspace ? `(${workspace.addButtons.length} add buttons, ${workspace.cards.length} ledgers inline)` : "(missing)");

/* The exact production figures the corrective pass must reproduce. */
const authoritativeNumbers = hasSummary && [
  "12,000,000", // gross client funding
  "960,000",    // initial consultancy fee (8%)
  "11,040,000", // net construction funding
  "7,000,000",  // approved actual cost
  "400,000",    // pending / unapproved cost
  "7,400,000",  // working actual cost
  "4,040,000",  // approved remaining client balance
  "3,640,000",  // working remaining client balance
].every((t) => summary.includes(t));
/* Client funding must never be presented as Larsa revenue or profit. */
const noFundingAsRevenue = hasSummary
  && !summary.includes("12,960,000")   // funding + fee dressed up as income
  && !summary.includes("5,960,000");   // funding − spending dressed up as profit
const refundNumber = authoritativeNumbers && noFundingAsRevenue;
const costProgress = hasSummary && summary.includes("Not Available") === false;
console.log("summary card:", hasSummary, "labels:", summaryChecks,
  "authoritative figures:", authoritativeNumbers, "funding kept out of revenue:", noFundingAsRevenue);

// Add a funding entry through the REAL modal → must hit acct_post_transaction.
await page.evaluate((id) => openEditor("funding", id), TXN.id);
await page.locator('#ed_fxRate[data-acct-prefill="1310"]').waitFor({ state: "attached" });
assert.equal(await page.locator("#ed_fxRate").inputValue(), "1310", "existing entry preserves its recorded rate");
assert.equal(await page.locator("#ed_date").inputValue(), "2026-01-10", "existing entry preserves its calendar date");
await page.evaluate(() => closeEditor());
await page.evaluate(`window.__larsaReturnProjectId = "prj1"; openEditor("funding", null);`);
await page.waitForTimeout(400);
const modalState = await page.evaluate(() => ({
  projectLocked: (document.getElementById("ed_projectId") || {}).disabled === true,
  dateFilled: !!(document.getElementById("ed_date") || {}).value,
  fxPrefilled: (document.getElementById("ed_fxRate") || {}).value,
  feePanel: !!document.getElementById("acct_fee_panel"),
}));
console.log("modal:", JSON.stringify(modalState));
await page.evaluate(() => {
  document.getElementById("ed_amount").value = "2000000";
  document.getElementById("ed_currency").value = "IQD";
  document.getElementById("ed_date").value = "2024-02-29";
  // Dual control: the counted statuses are hidden from an accountant's
  // status picker; the gated default ("Pending Approval") is used as-is.
  return saveEditor();
});
await page.waitForTimeout(800);
const posted = calls.filter((c) => c.name === "acct_post_transaction");
const receiptModalUp = await page.evaluate(() => {
  const m = document.querySelector("#modalRoot .modal");
  return m ? m.textContent.includes("LRS-RCP-000002") && m.textContent.includes("Print Receipt") : false;
});
const reviewMirror = await page.evaluate(() => state.funding[0] && state.funding[0].reviewStatus);
console.log("receipt modal:", receiptModalUp, "| mirror review status:", reviewMirror);
console.log("post calls:", posted.length, posted[0] ? JSON.stringify({ amount: posted[0].body.txn.amount, date: posted[0].body.txn.date, rateOverride: posted[0].body.txn.exchange_rate, status: posted[0].body.txn.status, kind: posted[0].body.txn.kind, project: posted[0].body.txn.project_id, actor: posted[0].body.actor.role }) : "-");

/* Assigning people is a dropdown: one line when shut, tick boxes when open,
   and the shut line keeps up as boxes are ticked. */
await page.evaluate(() => {
  const root = document.getElementById("modalRoot");
  if (root) root.innerHTML = "";
  return renderSettingsEnterprise();
});
await page.waitForTimeout(900);
const picker = await page.evaluate(() => {
  const dd = document.querySelector("details.acct-dd");
  if (!dd) return { found: false };
  const shutHeight = dd.getBoundingClientRect().height;
  const closedText = (dd.querySelector(".acct-dd-text") || {}).textContent;
  dd.open = true;
  const boxes = dd.querySelectorAll("input.acct-person");
  return {
    found: true,
    count: document.querySelectorAll("details.acct-dd").length,
    shutHeight: Math.round(shutHeight),
    closedText,
    people: boxes.length,
    openHeight: Math.round(dd.getBoundingClientRect().height),
    id: dd.id,
  };
});
let pickerLive = null;
if (picker.found && picker.people) {
  pickerLive = await page.evaluate((id) => {
    const box = document.querySelector("#" + id + " input.acct-person");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      label: (document.querySelector("#" + id + " .acct-dd-text") || {}).textContent,
      chosen: document.querySelectorAll("#" + id + " input.acct-person:checked").length,
      read: typeof readPicker === "function" ? null : null,
    };
  }, picker.id);
}
const pickerOk = picker.found && picker.people >= 2 && picker.shutHeight < 56
  && /Anyone with permission/.test(picker.closedText || "")
  && pickerLive && pickerLive.chosen === 1
  && !/Anyone with permission/.test(pickerLive.label || "");
console.log("people dropdown:", pickerOk, JSON.stringify({ ...picker, after: pickerLive }));

await browser.close();
const fatal = errors.filter((e) => !/Failed to fetch/.test(e));
console.log("page errors:", JSON.stringify(fatal));
const pass = mirror.on && mirror.fundingCount === 1 && mirror.fundingFee === 800000 && mirror.fundingNet === 9200000
  && mirror.managed && mirror.fxRate === 1310 && mirror.fundingDate === "2026-01-10" && mirror.projBudget === 100000000
  && hasSummary && summaryChecks && refundNumber && costProgress && workspaceOk
  && modalState.projectLocked && modalState.dateFilled && modalState.feePanel && modalState.fxPrefilled === "1450"
  && posted.length === 1 && posted[0].body.txn.amount === 2000000 && posted[0].body.txn.status === "pending"
  && posted[0].body.txn.date === "2024-02-29" && !Object.hasOwn(posted[0].body.txn, "exchange_rate")
  && receiptModalUp && reviewMirror === "pending_review"
  && pickerOk
  && fatal.length === 0;
console.log(pass ? "E2E SMOKE OK" : "E2E SMOKE FAILED");
process.exit(pass ? 0 : 1);
