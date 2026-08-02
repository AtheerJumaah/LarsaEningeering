/* Functional tests for the shared accounting core — the SAME file the
 * accounting engine loads in the browser (public/engines/accounting-core.js),
 * exercised here against the required examples from the accounting
 * specification. The server-side (authoritative) twin of every rule here is
 * tested in tests/accounting-sql.test.sql. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/* Evaluate the file exactly the way the browser does — as a classic script —
 * and read the LarsaAcctCore global it defines (same technique as
 * scripts/check-engines.mjs). */
const source = readFileSync(new URL("../public/engines/accounting-core.js", import.meta.url), "utf8");
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(source, sandbox);
const Core = sandbox.LarsaAcctCore;

const platform = {
  default_exchange_rate: 1310,
  default_fee_method: "percentage",
  default_fee_rate: 0.08,
  default_fee_basis: "funding",
  default_fee_treatment: "deduct_from_funding",
};

const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes

test("exchange-rate hierarchy: platform → project → transaction", () => {
  assert.deepEqual(plain(Core.resolveRate(platform, {}, null)), { rate: 1310, source: "platform_default" });
  assert.deepEqual(plain(Core.resolveRate(platform, { default_exchange_rate: 1450 }, null)),
    { rate: 1450, source: "project_default" });
  assert.deepEqual(plain(Core.resolveRate(platform, { default_exchange_rate: 1450 }, 1520)),
    { rate: 1520, source: "transaction_override" });
});

test("USD 1,000 at 1,500 plus USD 1,000 at 1,600 equals IQD 3,100,000 historically", () => {
  const a = Core.snapshot(1000, "USD", 1500);
  const b = Core.snapshot(1000, "USD", 1600);
  assert.equal(a.amount_iqd + b.amount_iqd, 3_100_000);
  assert.equal(a.amount_usd + b.amount_usd, 2000);
  // Changing a default later must not touch these snapshots — they are pure
  // functions of (amount, currency, historical rate); no default appears here.
});

test("fee hierarchy: platform 8% default → project → category → transaction override", () => {
  assert.equal(Core.resolveFeeRule(platform, { fee_inherit: true }, "funding").rate, 0.08);
  assert.equal(Core.resolveFeeRule(platform, { fee_inherit: true }, "funding").source, "platform_default");
  const project = {
    fee_inherit: false, fee_method: "percentage", fee_rate: 0.05, fee_basis: "funding",
    fee_treatment: "deduct_from_funding",
    fee_category_overrides: [{ category: "Special", method: "percentage", rate: 0.02 }],
  };
  assert.equal(Core.resolveFeeRule(platform, project, "funding").rate, 0.05);
  assert.equal(Core.resolveFeeRule(platform, project, "funding", "Special").rate, 0.02);
  assert.equal(Core.resolveFeeRule(platform, project, "funding", "Special").source, "category_override");
  const ov = Core.resolveFeeRule(platform, project, "funding", "Special", { method: "percentage", rate: 0.1 });
  assert.equal(ov.rate, 0.1);
  assert.equal(ov.source, "transaction_override");
});

test("incremental fees: 10,000,000 → 800,000; +2,000,000 → only +160,000 (total 960,000)", () => {
  const rule = Core.resolveFeeRule(platform, { fee_inherit: true }, "funding");
  const f1 = Core.feeForTxn({ kind: "funding", amount: 10_000_000, currency: "IQD", exchange_rate: 1310, status: "received" }, rule);
  const f2 = Core.feeForTxn({ kind: "funding", amount: 2_000_000, currency: "IQD", exchange_rate: 1310, status: "received" }, rule);
  assert.equal(f1.fee_amount, 800_000);
  assert.equal(f2.fee_amount, 160_000);
  assert.equal(f1.fee_amount + f2.fee_amount, 960_000);
  // Never 8% of the running 12,000,000 total:
  assert.notEqual(f2.fee_amount, 960_000);
});

test("fee posting status rules: estimated until received/posted (funding) or approved (expenses)", () => {
  const rule = Core.resolveFeeRule(platform, { fee_inherit: true }, "funding");
  assert.equal(Core.feeForTxn({ kind: "funding", amount: 100, currency: "IQD", exchange_rate: 1310, status: "draft" }, rule).status, "estimated");
  assert.equal(Core.feeForTxn({ kind: "funding", amount: 100, currency: "IQD", exchange_rate: 1310, status: "received" }, rule).status, "posted");
  const expRule = { method: "percentage", rate: 0.08, basis: "total_expenses", treatment: "larsa_revenue", source: "project_default" };
  assert.equal(Core.feeForTxn({ kind: "material", amount: 100, currency: "IQD", exchange_rate: 1310, status: "pending" }, expRule).status, "estimated");
  assert.equal(Core.feeForTxn({ kind: "material", amount: 100, currency: "IQD", exchange_rate: 1310, status: "approved" }, expRule).status, "posted");
});

test("materials-only and labor-only bases hit only their own kind; waivers produce no fee", () => {
  const matRule = { method: "percentage", rate: 0.04, basis: "materials_only", treatment: "larsa_revenue" };
  assert.equal(Core.feeForTxn({ kind: "material", amount: 5_000_000, currency: "IQD", exchange_rate: 1310, status: "approved" }, matRule).fee_amount, 200_000);
  assert.equal(Core.feeForTxn({ kind: "labor", amount: 5_000_000, currency: "IQD", exchange_rate: 1310, status: "approved" }, matRule), null);
  const labRule = { method: "percentage", rate: 0.04, basis: "labor_only", treatment: "larsa_revenue" };
  assert.equal(Core.feeForTxn({ kind: "labor", amount: 1_000_000, currency: "IQD", exchange_rate: 1310, status: "approved" }, labRule).fee_amount, 40_000);
  assert.equal(Core.feeForTxn({ kind: "material", amount: 1_000_000, currency: "IQD", exchange_rate: 1310, status: "approved" }, labRule), null);
  assert.equal(Core.feeForTxn({ kind: "funding", amount: 100, currency: "IQD", exchange_rate: 1310, status: "received" },
    { method: "waived", waived: true, basis: "funding" }), null);
});

test("the required refund example: 10M gross, 8%, 7M spent → 2,376,000 refund / 624,000 retained", () => {
  const refund = Core.computeRefund(
    [{ amount_iqd: 10_000_000, fee_iqd: 800_000, fee_rate: 0.08, fee_method: "percentage", fee_treatment: "deduct_from_funding", currency: "IQD", exchange_rate: 1310 }],
    7_000_000, null, 0);
  assert.equal(refund.net_construction_funding_iqd, 9_200_000);
  assert.equal(refund.unused_net_funding_iqd, 2_200_000);
  assert.equal(refund.refundable_fee_iqd, 176_000);
  assert.equal(refund.total_refund_iqd, 2_376_000);
  assert.equal(refund.retained_fee_iqd, 624_000);
});

test("partial refunds reverse only the relevant fee", () => {
  const refund = Core.computeRefund(
    [{ amount_iqd: 10_000_000, fee_iqd: 800_000, fee_rate: 0.08, fee_method: "percentage", fee_treatment: "deduct_from_funding", currency: "IQD", exchange_rate: 1310 }],
    7_000_000, 1_000_000, 0);
  assert.equal(refund.refund_principal_iqd, 1_000_000);
  assert.equal(refund.refundable_fee_iqd, 80_000);
  assert.equal(refund.total_refund_iqd, 1_080_000);
  assert.equal(refund.partial, true);
});

test("multiple funding entries refund at EACH entry's snapshotted rate, FIFO", () => {
  // Older entry at 8%, newer at 5%. Expenses consume the older entry first,
  // so the unused tail is: rest of entry 1 at 8% + all of entry 2 at 5%.
  const refund = Core.computeRefund(
    [
      { amount_iqd: 10_000_000, fee_iqd: 800_000, fee_rate: 0.08, fee_method: "percentage", fee_treatment: "deduct_from_funding", currency: "IQD", exchange_rate: 1500 },
      { amount_iqd: 5_000_000, fee_iqd: 250_000, fee_rate: 0.05, fee_method: "percentage", fee_treatment: "deduct_from_funding", currency: "IQD", exchange_rate: 1600 },
    ],
    7_000_000, null, 0);
  // net1 = 9.2M (2.2M unused after 7M expenses), net2 = 4.75M all unused
  assert.equal(refund.unused_net_funding_iqd, 6_950_000);
  assert.equal(refund.refundable_fee_iqd, Core.round2(2_200_000 * 0.08 + 4_750_000 * 0.05)); // 176,000 + 237,500
  assert.equal(refund.refundable_fee_iqd, 413_500);
  // Historical rates preserved per allocation:
  assert.equal(refund.allocations[0].fee_rate, 0.08);
  assert.equal(refund.allocations[1].fee_rate, 0.05);
});

test("fixed-fee funding earns no refundable percentage", () => {
  const refund = Core.computeRefund(
    [{ amount_iqd: 20_000_000, fee_iqd: 1_500_000, fee_rate: 0, fee_method: "fixed_per_project", fee_treatment: "project_expense", currency: "IQD", exchange_rate: 1310 }],
    5_000_000, 2_000_000, 0);
  assert.equal(refund.refundable_fee_iqd, 0);
  assert.equal(refund.total_refund_iqd, 2_000_000);
});

test("project summary keeps funding, cost, fees, and refunds separate", () => {
  const project = { id: "p1", currency: "IQD", contract_value: 150_000_000, approved_budget: 100_000_000, budget_currency: "IQD" };
  const txns = [
    { id: "t1", project_id: "p1", kind: "funding", status: "received", txn_date: "2026-01-10", amount_iqd: 10_000_000, amount_usd: 7633.59, original_currency: "IQD", exchange_rate: 1310 },
    { id: "t2", project_id: "p1", kind: "material", status: "approved", txn_date: "2026-02-01", amount_iqd: 3_000_000, amount_usd: 2290.08, original_currency: "IQD", exchange_rate: 1310 },
    { id: "t3", project_id: "p1", kind: "labor", status: "approved", txn_date: "2026-02-15", amount_iqd: 2_500_000, amount_usd: 1908.4, original_currency: "IQD", exchange_rate: 1310 },
    { id: "t4", project_id: "p1", kind: "expense", status: "approved", txn_date: "2026-03-01", amount_iqd: 1_500_000, amount_usd: 1145.04, original_currency: "IQD", exchange_rate: 1310 },
    { id: "t5", project_id: "p1", kind: "expense", status: "pending", txn_date: "2026-03-20", amount_iqd: 400_000, amount_usd: 305.34, original_currency: "IQD", exchange_rate: 1310 },
  ];
  const fees = [
    { id: "f1", project_id: "p1", source_txn_id: "t1", entry_type: "fee", status: "posted", calc_method: "percentage", fee_rate: 0.08, fee_iqd: 800_000, fee_usd: 610.69, treatment: "deduct_from_funding" },
  ];
  const s = Core.projectSummary(project, txns, fees, [
    { project_id: "p1", percent: 35, update_date: "2026-02-20", created_at: "a" },
    { project_id: "p1", percent: 45, update_date: "2026-03-10", created_at: "b", updated_by_name: "Site Eng" },
  ]);
  assert.equal(s.gross_funding_iqd, 10_000_000);
  assert.equal(s.initial_fee_iqd, 800_000);
  assert.equal(s.net_construction_funding_iqd, 9_200_000);
  assert.equal(s.materials_iqd, 3_000_000);
  assert.equal(s.labor_iqd, 2_500_000);
  assert.equal(s.other_expenses_iqd, 1_500_000);
  assert.equal(s.actual_construction_cost_iqd, 7_000_000);
  assert.equal(s.total_used_iqd, 7_800_000);            // cost + fee charged to funding
  assert.equal(s.pending_commitments_iqd, 400_000);     // never mixed into actuals
  assert.equal(s.remaining_unused_iqd, 2_200_000);
  assert.equal(s.refundable_fee_iqd, 176_000);
  assert.equal(s.total_refund_due_iqd, 2_376_000);
  assert.equal(s.final_fee_retained_iqd, 624_000);
  assert.equal(s.cost_progress_pct, 7);                 // 7,000,000 of 100,000,000
  assert.equal(s.schedule_progress_pct, 45);
  assert.equal(s.schedule_progress_by, "Site Eng");
});

test("a fee recorded as separate Larsa revenue never reduces construction funding or joins project cost", () => {
  const project = { id: "p2", currency: "USD" };
  const txns = [
    { id: "u1", project_id: "p2", kind: "funding", status: "received", txn_date: "2026-01-01", amount_iqd: 1_500_000, amount_usd: 1000, original_currency: "USD", exchange_rate: 1500 },
    { id: "u2", project_id: "p2", kind: "material", status: "approved", txn_date: "2026-02-01", amount_iqd: 600_000, amount_usd: 400, original_currency: "USD", exchange_rate: 1500 },
  ];
  const fees = [
    { id: "g1", project_id: "p2", source_txn_id: "u2", entry_type: "fee", status: "posted", calc_method: "percentage", fee_rate: 0.08, fee_iqd: 48_000, fee_usd: 32, treatment: "larsa_revenue" },
  ];
  const s = Core.projectSummary(project, txns, fees, []);
  assert.equal(s.net_construction_funding_iqd, 1_500_000); // NOT reduced
  assert.equal(s.total_used_iqd, 600_000);                 // fee NOT in project cost
  assert.equal(s.fee_as_larsa_revenue_iqd, 48_000);        // tracked separately once
});

test("no-budget cost progress is Not Available (null), never contract value or funding", () => {
  const s = Core.projectSummary({ id: "p3", currency: "IQD", contract_value: 99 },
    [{ id: "x", project_id: "p3", kind: "expense", status: "approved", txn_date: "2026-01-01", amount_iqd: 50, amount_usd: 0.04, original_currency: "IQD", exchange_rate: 1310 }], [], []);
  assert.equal(s.cost_progress_pct, null);
});

test("amounts in words for receipts — English and Arabic, both currencies", () => {
  assert.equal(Core.numberToWordsEn(2_376_000), "Two Million Three Hundred Seventy-Six Thousand");
  assert.equal(Core.numberToWordsEn(960_000), "Nine Hundred Sixty Thousand");
  assert.equal(Core.amountInWords(2_376_000, "IQD", "en"), "Two Million Three Hundred Seventy-Six Thousand Iraqi Dinars Only");
  assert.equal(Core.amountInWords(1_500.25, "USD", "en"), "One Thousand Five Hundred US Dollars and Twenty-Five Cents Only");
  assert.equal(Core.numberToWordsAr(2_000_000), "مليونان");
  assert.equal(Core.numberToWordsAr(800_000), "ثمانمائة ألف");
  assert.ok(Core.amountInWords(10_000_000, "IQD", "ar").includes("دينار عراقي"));
  assert.ok(Core.amountInWords(10_000_000, "IQD", "ar").endsWith("لا غير"));
});

test("aggregate review status: red beats yellow beats green; approval never changes amounts", () => {
  assert.equal(Core.aggregateStatus(["approved", "approved"]), "green");
  assert.equal(Core.aggregateStatus(["approved", "pending_review"]), "yellow");
  assert.equal(Core.aggregateStatus(["approved", "unreviewed"]), "yellow");
  assert.equal(Core.aggregateStatus(["pending_review", "needs_correction"]), "red");
  assert.equal(Core.aggregateStatus([]), null);
  assert.equal(Core.reviewMeta("pending_review").color, "yellow");
  assert.equal(Core.reviewMeta("approved").icon, "✔");
  // Text label + icon accompany the color (never color alone):
  assert.ok(Core.reviewMeta("needs_correction").en.length > 0 && Core.reviewMeta("needs_correction").ar.length > 0);
});
