import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const section = (start, end) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const calculations = [
  section("function finiteNumber(", "function dateInputValue("),
  section("const DEFAULT_IQD_RATE", "function readAccountingSnapshot("),
  section("type ProjectFinancials", "/* A worked example"),
  section("type ServerFinancialRow", "function ConstructionFinancials("),
  "({ readLedger, financialsFor, monthlySeries, fromServerRow, addFinancials, payrollCompanyCostUsd, ZERO_FINANCIALS })",
].join("\n");
const { readLedger, financialsFor, monthlySeries, fromServerRow, addFinancials, payrollCompanyCostUsd, ZERO_FINANCIALS } =
  runInNewContext(ts.transpileModule(calculations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

test("offline monthly totals preserve stored currency equivalents and the cost bearer", () => {
  const funding = [
    { id: "one", projectId: "p1", date: "2024-02-29", status: "Received", currency: "USD", amount: 100,
      fxRate: 1500, consultancyFee: 8, _acct: { amount_usd: 100, amount_iqd: 150000 } },
    { id: "two", projectId: "p1", date: "2024-03-01", status: "Received", currency: "USD", amount: 100,
      consultancyFee: 10, fxRate: 1600,
      _acct: { amount_usd: 100, amount_iqd: 160000, fee_rule: { treatment: "larsa_revenue" } } },
  ];
  const materials = [
    { projectId: "p1", date: "2024-02-29", status: "Approved", currency: "IQD", amount: 15000 },
    { projectId: "p1", date: "2024-02-29", status: "Pending Approval", currency: "IQD", amount: 5000 },
    { projectId: "p1", date: "2024-03-01", status: "Approved", currency: "IQD", amount: 3200,
      paymentSource: "Client account", _acct: { meta: { cost_bearer: "company" }, amount_usd: 2, amount_iqd: 3200 } },
    { projectId: "p2", date: "2024-03-01", status: "Approved", currency: "IQD", amount: 9999 },
  ];
  const before = JSON.stringify({ funding, materials });
  const snapshot = {
    rate: 2000, funding: readLedger(funding, "amount"), materials: readLedger(materials, "amount"),
    expenses: [], revenue: [], labor: [],
  };
  const ids = new Set(["p1"]);
  const iqd = financialsFor(snapshot, ids, "IQD");
  const usd = financialsFor(snapshot, ids, "USD");
  assert.equal(iqd.funding, 310000);
  assert.equal(iqd.fees, 12000);
  assert.equal(iqd.feeRevenue, 28000);
  assert.equal(iqd.cost, 15000);
  assert.equal(iqd.workingCost, 20000);
  assert.equal(iqd.balance, 283000);
  assert.equal(iqd.companyExpenses, 3200);
  assert.equal(usd.funding, 200);
  assert.equal(usd.companyExpenses, 2);
  assert.equal(usd.companyNet, 16);
  assert.equal(monthlySeries(snapshot, ids, "IQD")[0].figures.funding, 150000);
  assert.equal(monthlySeries(snapshot, ids, "IQD")[1].figures.funding, 160000);
  assert.equal(JSON.stringify({ funding, materials }), before);
});

test("server totals use the original currency basis and keep deducted fees separate from fee revenue", () => {
  const row = {
    client_funds: { approved: { gross_funding_usd: 200, gross_funding_iqd: 310000, initial_fee_iqd: 12000 } },
    company: { consultancy_fee_revenue_iqd: 18000, larsa_revenue_iqd: 20000, company_net_profit_iqd: 15000,
      company_expenses_iqd: 5000, company_expenses_usd: 3.13 },
  };
  const iqd = addFinancials(ZERO_FINANCIALS, fromServerRow(row, "IQD"));
  assert.equal(iqd.funding, 310000);
  assert.equal(iqd.fees, 12000);
  assert.equal(iqd.feeRevenue, 18000);
  assert.equal(iqd.companyExpenses, 5000);
  assert.equal(iqd.margin, 75);
  assert.equal(fromServerRow(row, "USD").funding, 200);
  assert.equal(fromServerRow(row, "USD").companyExpenses, 3.13);
});

test("sales commission salary totals convert each payroll line before adding it to USD commissions", () => {
  const payroll = [
    { totalCompanyCost: 150000, currency: "IQD", fxRate: 1500 },
    { totalCompanyCost: 160000, currency: "IQD", fxRate: 1600 },
    { totalCompanyCost: 200, currency: "USD", fxRate: 0 },
    { totalCompanyCost: 100000, currency: "IQD", fxRate: 0 },
    { totalCompanyCost: 0, grossPay: 100, currency: "USD", fxRate: 0 },
  ];
  assert.equal(payrollCompanyCostUsd(payroll, 2000), 450);
});
