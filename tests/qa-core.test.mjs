/* QA audit — the controlled-number checks against the authoritative
 * calculation module (public/engines/accounting-core.js), which mirrors the
 * server-side acct_* maths. These are the specification's own examples:
 * if any of these ever drifts, a formula regressed somewhere it matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { QA_EXPECT } from "./qa-fixture.mjs";

/* Evaluate the module the way the browser does — as a classic script. */
const source = readFileSync(new URL("../public/engines/accounting-core.js", import.meta.url), "utf8");
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(source, sandbox);
const Core = sandbox.LarsaAcctCore;

const PROJECT = {
  id: "zz-qa-p1", contract_value: 150000000, approved_budget: QA_EXPECT.budget,
  budget_currency: "IQD", currency: "IQD",
};

/* The exact fixture the spec describes: funding 100,000,000 with an 8% fee
 * deducted from funding; materials 20,000,000 and labor 10,000,000 approved;
 * one 5,000,000 expense still pending. */
const TXNS = [
  { id: "t-f1", project_id: "zz-qa-p1", kind: "funding", status: "received", txn_date: "2026-07-05", amount_iqd: 100000000, amount_usd: 66666.67, original_currency: "IQD", exchange_rate: 1500 },
  { id: "t-m1", project_id: "zz-qa-p1", kind: "material", status: "approved", txn_date: "2026-07-08", amount_iqd: 20000000, amount_usd: 13333.33, original_currency: "IQD", exchange_rate: 1500 },
  { id: "t-l1", project_id: "zz-qa-p1", kind: "labor", status: "approved", txn_date: "2026-07-09", amount_iqd: 10000000, amount_usd: 6666.67, original_currency: "IQD", exchange_rate: 1500 },
  { id: "t-e1", project_id: "zz-qa-p1", kind: "expense", status: "pending", txn_date: "2026-07-10", amount_iqd: 5000000, amount_usd: 3333.33, original_currency: "IQD", exchange_rate: 1500 },
];
const FEES = [
  { id: "fee-1", project_id: "zz-qa-p1", source_txn_id: "t-f1", entry_type: "fee", status: "posted", treatment: "deduct_from_funding", fee_iqd: 8000000, fee_rate: 0.08, calc_method: "percentage" },
];

test("QA spec: the project summary lands on the exact controlled numbers", () => {
  const s = Core.projectSummary(PROJECT, TXNS, FEES, []);
  assert.equal(s.gross_funding_iqd, QA_EXPECT.funding);
  assert.equal(s.initial_fee_iqd, QA_EXPECT.fee);
  assert.equal(s.net_construction_funding_iqd, QA_EXPECT.netFunding); // 100M − 8M
  assert.equal(s.actual_construction_cost_iqd, QA_EXPECT.actualCost); // 20M + 10M
  assert.equal(s.total_used_iqd, QA_EXPECT.totalUsed); // 30M + 8M, fee once
  assert.equal(s.remaining_unused_iqd, QA_EXPECT.remaining); // 92M − 30M
  assert.equal(s.pending_commitments_iqd, QA_EXPECT.pending);
  assert.equal(s.cost_progress_pct, QA_EXPECT.costProgressPct); // 30M of 120M
});

test("QA spec: the pending 5,000,000 never joins actual cost, and the fee is never double-counted", () => {
  const s = Core.projectSummary(PROJECT, TXNS, FEES, []);
  // Actual cost is materials + labor only — pending stays out.
  assert.equal(s.actual_construction_cost_iqd, 30000000);
  // The fee appears once in total_used and once as the funding deduction —
  // never both added into actual cost as well.
  assert.equal(s.total_used_iqd - s.actual_construction_cost_iqd, QA_EXPECT.fee);
  // Approving the pending expense moves exactly 5M from pending to actual.
  const approved = TXNS.map((t) => (t.id === "t-e1" ? { ...t, status: "approved" } : t));
  const s2 = Core.projectSummary(PROJECT, approved, FEES, []);
  assert.equal(s2.actual_construction_cost_iqd, 35000000);
  assert.equal(s2.pending_commitments_iqd, 0);
  assert.equal(s2.remaining_unused_iqd, 57000000);
});

test("QA spec: no approved budget means Not-available progress, never a made-up percent", () => {
  const s = Core.projectSummary({ ...PROJECT, approved_budget: null }, TXNS, FEES, []);
  assert.equal(s.cost_progress_pct, null);
  const zero = Core.projectSummary({ ...PROJECT, approved_budget: 0 }, TXNS, FEES, []);
  assert.equal(zero.cost_progress_pct, null);
});

test("QA spec: historical USD payments keep their own day's rate — $2,000 stays IQD 3,100,000", () => {
  const one = Core.snapshot(1000, "USD", 1500);
  const two = Core.snapshot(1000, "USD", 1600);
  assert.equal(one.amount_iqd, 1500000);
  assert.equal(two.amount_iqd, 1600000);
  assert.equal(one.amount_usd + two.amount_usd, QA_EXPECT.fxUsd);
  assert.equal(one.amount_iqd + two.amount_iqd, QA_EXPECT.fxIqd);
  // Changing the platform's current rate must not move a stored snapshot:
  // the snapshot is a pure function of the rate recorded on the transaction.
  const afterRateChange = Core.snapshot(1000, "USD", 1500);
  assert.deepEqual(afterRateChange, one);
  // And the rate hierarchy only reaches the platform default when nothing
  // closer to the transaction exists.
  assert.equal(Core.resolveRate({ default_exchange_rate: 1310 }, null, 1500).rate, 1500);
  assert.equal(Core.resolveRate({ default_exchange_rate: 1310 }, { default_exchange_rate: 1450 }, null).rate, 1450);
  assert.equal(Core.resolveRate({ default_exchange_rate: 1310 }, null, null).rate, 1310);
});

test("QA spec: consultancy fee priority — entry beats category beats project beats the 8% global", () => {
  const platform = { default_fee_rate: 0.08 };
  const project = {
    fee_method: "percentage", fee_rate: 0.06, fee_inherit: false,
    fee_category_overrides: [{ category: "materials", method: "percentage", rate: 0.05 }],
  };
  const entry = Core.resolveFeeRule(platform, project, "funding", null, { method: "percentage", rate: 0.03 });
  assert.equal(entry.rate, 0.03);
  assert.equal(entry.source, "transaction_override");
  const category = Core.resolveFeeRule(platform, project, "material", "materials", null);
  assert.equal(category.rate, 0.05);
  assert.equal(category.source, "category_override");
  const projectRule = Core.resolveFeeRule(platform, project, "funding", null, null);
  assert.equal(projectRule.rate, 0.06);
  assert.equal(projectRule.source, "project_default");
  const global = Core.resolveFeeRule(platform, null, "funding", null, null);
  assert.equal(global.rate, 0.08);
  assert.equal(global.source, "platform_default");
  // And with no configuration at all, the global default is still 8%.
  assert.equal(Core.resolveFeeRule({}, null, "funding", null, null).rate, 0.08);
});

test("QA spec: a waiver produces no fee, and the waiver rule carries its reason", () => {
  const rule = Core.resolveFeeRule({ default_fee_rate: 0.08 }, null, "funding", null,
    { method: "waived", waiver_reason: "client is a charity" });
  assert.equal(rule.waived, true);
  assert.equal(rule.waiver_reason, "client is a charity");
  const fee = Core.feeForTxn({ kind: "funding", status: "received", amount: 100000000, currency: "IQD", exchange_rate: 1500 }, rule);
  assert.equal(fee, null);
});

test("QA spec: one funding of 100,000,000 at 8% yields exactly one 8,000,000 fee", () => {
  const rule = Core.resolveFeeRule({ default_fee_rate: 0.08 }, null, "funding", null, null);
  const fee = Core.feeForTxn(
    { kind: "funding", status: "received", amount: 100000000, currency: "IQD", exchange_rate: 1500 }, rule);
  assert.equal(fee.fee_amount, 8000000);
  assert.equal(fee.fee_iqd, 8000000);
  assert.equal(fee.status, "posted");
  // A draft funding only ever gets an estimate — nothing posts early.
  const draft = Core.feeForTxn(
    { kind: "funding", status: "draft", amount: 100000000, currency: "IQD", exchange_rate: 1500 }, rule);
  assert.equal(draft.status, "estimated");
});
