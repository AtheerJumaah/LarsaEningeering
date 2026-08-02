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
const TXN = { id: "11111111-1111-4111-8111-111111111111", txn_no: "LRS-TXN-000001", project_id: "prj1", kind: "funding", category: "Client Funding", description: "First funding", txn_date: "2026-01-10", status: "received", original_amount: 10000000, original_currency: "IQD", exchange_rate: 1310, rate_source: "platform_default", amount_iqd: 10000000, amount_usd: 7633.59, fee_rule: { method: "percentage", rate: 0.08, basis: "funding", treatment: "deduct_from_funding", source: "platform_default" }, is_sample: false, meta: {}, created_at: "2026-01-10" };
const FEE = { id: "22222222-2222-4222-8222-222222222222", project_id: "prj1", source_txn_id: TXN.id, entry_type: "fee", calc_method: "percentage", fee_rate: 0.08, calc_basis: "funding", basis_amount: 10000000, fee_amount: 800000, currency: "IQD", exchange_rate: 1310, fee_iqd: 800000, fee_usd: 610.69, treatment: "deduct_from_funding", config_source: "platform_default", status: "posted", provisional: true, is_sample: false, created_at: "2026-01-10" };
const bootstrap = {
  settings: { default_exchange_rate: 1310, default_fee_method: "percentage", default_fee_rate: 0.08, default_fee_basis: "funding", default_fee_treatment: "deduct_from_funding", sample_state: "removed" },
  projects: [PROJECT], transactions: [TXN], fee_ledger: [FEE], refund_settlements: [],
  progress: [{ id: "p", project_id: "prj1", percent: 45, update_date: "2026-03-10", updated_by_name: "Site Eng", created_at: "x" }],
  approvals: [], review_queue: [], audit_recent: [], archives: [],
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
      else if (name === "acct_is_platform_admin") res.end("false");
      else if (name === "acct_post_transaction") res.end(JSON.stringify({ ok: true, txn: { ...TXN, id: "33333333-3333-4333-8333-333333333333", txn_no: "LRS-TXN-000002" }, fee: { fee_amount: 160000, currency: "IQD", status: "posted" } }));
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
await page.goto("http://127.0.0.1:8932/engines/accounting.html", { waitUntil: "load" });
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
const summaryChecks = hasSummary && ["Contract Value", "Net Construction Funding", "Total Refund Due to Client", "Cost Progress"].every((t) => summary.includes(t));
const refundNumber = hasSummary && summary.includes("9,936,000"); // 9.2M unused + 8% (736,000) — no expenses in this fixture
const costProgress = hasSummary && summary.includes("Not Available") === false;
console.log("summary card:", hasSummary, "labels:", summaryChecks, "refund 9,936,000 shown:", refundNumber);

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
  document.getElementById("ed_status").value = "Received";
  return saveEditor();
});
await page.waitForTimeout(800);
const posted = calls.filter((c) => c.name === "acct_post_transaction");
console.log("post calls:", posted.length, posted[0] ? JSON.stringify({ amount: posted[0].body.txn.amount, status: posted[0].body.txn.status, kind: posted[0].body.txn.kind, project: posted[0].body.txn.project_id, actor: posted[0].body.actor.role }) : "-");

await browser.close(); server.close();
const fatal = errors.filter((e) => !/Failed to fetch/.test(e));
console.log("page errors:", JSON.stringify(fatal));
const pass = mirror.on && mirror.fundingCount === 1 && mirror.fundingFee === 800000 && mirror.fundingNet === 9200000
  && mirror.managed && mirror.fxRate === 1310 && mirror.projBudget === 100000000
  && hasSummary && summaryChecks && refundNumber && costProgress
  && modalState.projectLocked && modalState.dateFilled && modalState.feePanel
  && posted.length === 1 && posted[0].body.txn.amount === 2000000 && posted[0].body.txn.status === "received"
  && fatal.length === 0;
console.log(pass ? "E2E SMOKE OK" : "E2E SMOKE FAILED");
process.exit(pass ? 0 : 1);
