/* Browser E2E smoke for the v4.0 accounting layer against a mocked Supabase.
 * Run manually: node tests/accounting-e2e.smoke.mjs
 * Needs Chromium (PLAYWRIGHT executablePath below) — intentionally named
 * .smoke.mjs so `node --test tests/*.test.mjs` does not require a browser. */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "/home/claude/repo/public";
const calls = [];
const PROJECT = { id: "prj1", name: "E2E Villa", currency: "IQD", fee_inherit: true, approved_budget: 100000000, budget_currency: "IQD", contract_value: 150000000, is_sample: false, created_at: "2026-01-01" };
const TXN = { id: "11111111-1111-4111-8111-111111111111", review_status: "pending_review", txn_no: "LRS-TXN-000001", project_id: "prj1", kind: "funding", category: "Client Funding", description: "First funding", txn_date: "2026-01-10", status: "received", original_amount: 10000000, original_currency: "IQD", exchange_rate: 1310, rate_source: "platform_default", amount_iqd: 10000000, amount_usd: 7633.59, fee_rule: { method: "percentage", rate: 0.08, basis: "funding", treatment: "deduct_from_funding", source: "platform_default" }, is_sample: false, meta: {}, created_at: "2026-01-10" };
const FEE = { id: "22222222-2222-4222-8222-222222222222", project_id: "prj1", source_txn_id: TXN.id, entry_type: "fee", calc_method: "percentage", fee_rate: 0.08, calc_basis: "funding", basis_amount: 10000000, fee_amount: 800000, currency: "IQD", exchange_rate: 1310, fee_iqd: 800000, fee_usd: 610.69, treatment: "deduct_from_funding", config_source: "platform_default", status: "posted", provisional: true, is_sample: false, created_at: "2026-01-10" };
const RECEIPT = { id: "44444444-4444-4444-8444-444444444444", receipt_no: "LRS-RCP-000001", txn_id: TXN.id, project_id: "prj1", kind: "original", version: 1, status_at_issue: "pending_review", created_at: "2026-01-10",
  snapshot: { receipt_no: "LRS-RCP-000001", txn_no: TXN.txn_no, project_id: "prj1", project_code: "E2E", project_name: "E2E Villa", payer_name: "Client X", amount: 10000000, currency: "IQD", amount_iqd: 10000000, amount_usd: 7633.59, exchange_rate: 1310, txn_date: "2026-01-10", payment_method: "Cash", fee_rate: 0.08, fee_amount: 800000, fee_treatment: "deduct_from_funding", net_after_fee: 9200000, received_by: "Site Office", entered_by_name: "E2E Accountant", review_status_at_issue: "pending_review", verify_code: "ABC123", timezone: "Asia/Baghdad", issued_at: "2026-01-10T10:00:00Z" } };
const bootstrap = {
  settings: { default_exchange_rate: 1310, default_fee_method: "percentage", default_fee_rate: 0.08, default_fee_basis: "funding", default_fee_treatment: "deduct_from_funding", sample_state: "removed" },
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
    total_refund_due_iqd: 0, gross_funding_usd: 9160.31, construction_cost_approved_usd: 5343.51,
  },
  company: {
    consultancy_fee_revenue_iqd: 960000, engineering_revenue_iqd: 0, other_revenue_iqd: 0,
    larsa_revenue_iqd: 960000, company_expenses_iqd: 0, fee_refunds_reversals_iqd: 0,
    company_net_profit_iqd: 960000, net_margin_pct: 100,
    larsa_revenue_usd: 732.82, company_net_profit_usd: 732.82,
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

const server = createServer((req, res) => {
  if (req.url.startsWith("/rest/v1/rpc/")) {
    const name = req.url.split("/rest/v1/rpc/")[1].split("?")[0];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ name, body: body ? JSON.parse(body) : null });
      res.setHeader("Content-Type", "application/json");
      if (name === "acct_get_bootstrap") res.end(JSON.stringify(bootstrap));
      else if (name === "acct_company_financials") res.end(JSON.stringify(COMPANY_FIN));
      else if (name === "acct_approval_queue") res.end(JSON.stringify({ total: 1, by_kind: { expense: 1 }, rows: [
        { id: "aa", queue_type: "transaction", record_kind: "expense", reference: "LRS-TXN-000009", project_id: "prj1",
          project_name: "E2E Villa", description: "Pending permit", amount: 400000, currency: "IQD",
          entered_by: "e2e@larsaeng.com", entered_by_name: "E2E Accountant", assigned_approver: "Any authorised approver",
          age_days: 3, action: "approve_entry", action_label: "Approve so it counts", payment_status: "pending" }] }));
      else if (name === "acct_audit_page") res.end(JSON.stringify({ total: 2, actions: ["Funding Added"], rows: [
        { id: 2, at: "2026-03-11T09:00:00Z", actor_email: "e2e@larsaeng.com", actor_name: "E2E Accountant",
          actor_role: "Accountant", project_id: "prj1", record_type: "funding", record_id: "x",
          action: "Funding Added", reason: null, details: "LRS-TXN-000001", changed_fields: [] }] }));
      else if (name === "acct_is_platform_admin") res.end("false");
      else if (name === "acct_get_my_permissions") res.end(JSON.stringify({ view: true, create: true, submit_review: true, print_receipts: true, reprint_receipts: true, approve: false, reject: false, export_working: true, edit_own_unapproved: true }));
      else if (name === "acct_post_transaction") res.end(JSON.stringify({ ok: true, txn: { ...TXN, id: "33333333-3333-4333-8333-333333333333", txn_no: "LRS-TXN-000002" }, fee: { fee_amount: 160000, currency: "IQD", status: "posted" },
        receipt: { ...RECEIPT, id: "55555555-5555-4555-8555-555555555555", receipt_no: "LRS-RCP-000002", txn_id: "33333333-3333-4333-8333-333333333333", snapshot: { ...RECEIPT.snapshot, receipt_no: "LRS-RCP-000002", amount: 2000000, amount_iqd: 2000000 } } }));
      else res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  const p = join(root, req.url.split("?")[0]);
  if (existsSync(p) && statSync(p).isFile()) {
    res.setHeader("Content-Type", p.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(readFileSync(p));
  } else { res.statusCode = 404; res.end("nope"); }
});
await new Promise((r) => server.listen(8932, r));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem("larsaSupabaseBridgeV1", JSON.stringify({ url: "http://127.0.0.1:8932", anonKey: "test-anon" }));
});
await page.goto("http://127.0.0.1:8932/engines/accounting.html?demo=1", { waitUntil: "load" });
await page.waitForTimeout(2000);

// Sign a writer in, the way the parent shell does (lexical global assignment).
await page.evaluate(`
  currentUser = { id: "u1", name: "E2E Accountant", email: "e2e@larsaeng.com", role: "Accountant", active: true };
  var app = document.getElementById("app"); if (app) app.style.display = "flex";
  var login = document.getElementById("loginScreen"); if (login) login.style.display = "none";
`);
await page.waitForTimeout(500);

const mirror = await page.evaluate(() => ({
  on: window.ACCT && window.ACCT.on,
  fundingCount: state.funding.length,
  fundingFee: state.funding[0] && state.funding[0].consultancyFee,
  fundingNet: state.funding[0] && state.funding[0].netConstruction,
  managed: state.funding[0] && state.funding[0]._acctManaged === true,
  fxRate: state.funding[0] && state.funding[0].fxRate,
  projBudget: (state.projects.find(p => p.id === "prj1") || {}).approvedBudget,
}));
console.log("mirror:", JSON.stringify(mirror));

// Open the project detail and confirm the §4 summary card injects.
await page.evaluate(`openProjectDetail("prj1", "summary")`);
await page.waitForTimeout(700);
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
console.log("post calls:", posted.length, posted[0] ? JSON.stringify({ amount: posted[0].body.txn.amount, status: posted[0].body.txn.status, kind: posted[0].body.txn.kind, project: posted[0].body.txn.project_id, actor: posted[0].body.actor.role }) : "-");

await browser.close(); server.close();
const fatal = errors.filter((e) => !/Failed to fetch/.test(e));
console.log("page errors:", JSON.stringify(fatal));
const pass = mirror.on && mirror.fundingCount === 1 && mirror.fundingFee === 800000 && mirror.fundingNet === 9200000
  && mirror.managed && mirror.fxRate === 1310 && mirror.projBudget === 100000000
  && hasSummary && summaryChecks && refundNumber && costProgress
  && modalState.projectLocked && modalState.dateFilled && modalState.feePanel
  && posted.length === 1 && posted[0].body.txn.amount === 2000000 && posted[0].body.txn.status === "pending"
  && receiptModalUp && reviewMirror === "pending_review"
  && fatal.length === 0;
console.log(pass ? "E2E SMOKE OK" : "E2E SMOKE FAILED");
process.exit(pass ? 0 : 1);
