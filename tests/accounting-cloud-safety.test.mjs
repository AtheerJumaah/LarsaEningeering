import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const coreSource = readFileSync(new URL("../public/engines/accounting-core.js", import.meta.url), "utf8");
const cloudSource = readFileSync(new URL("../public/engines/accounting-cloud.js", import.meta.url), "utf8");

function createEngine({ state, respond, saveEditor = () => false }) {
  const calls = [];
  const messages = [];
  const writes = [];
  let start;
  const account = {
    currentUser: { email: "accountant@example.test", role: "Accountant" },
    location: { pathname: "/fixture", search: "" },
    document: {
      readyState: "loading",
      addEventListener(event, cb) { if (event === "DOMContentLoaded") start = cb; },
      getElementById() { return null; },
      createElement() { return {}; },
      head: { appendChild() {} },
    },
    localStorage: {
      getItem(k) { return k === "larsaSupabaseBridgeV1" ? '{"url":"https://accounting.invalid","anonKey":"fixture"}' : null; },
    },
    console: { warn() {}, log() {} },
    async fetch(url, opts) {
      const name = url.split("/").at(-1);
      const request = JSON.parse(opts.body);
      calls.push({ name, request });
      const response = await respond(name, request);
      return { ok: !response?.error, text: async () => JSON.stringify(response ?? null) };
    },
    state,
    save() { writes.push(JSON.stringify(account.state)); return true; },
    saveEditor,
    toast(message) { messages.push(message); },
    render() {},
  };
  account.self = account.window = account.top = account;
  vm.createContext(account);
  vm.runInContext(coreSource, account);
  vm.runInContext(cloudSource, account);
  start();
  return { account, calls, messages, writes };
}

const basicResponses = {
  acct_get_bootstrap: { settings: { sample_state: "never_seeded" }, projects: [], transactions: [] },
  acct_company_financials: { rows: [] },
};

test("opening and refreshing an empty shared ledger leaves browser records alone", async () => {
  const legacy = { id: "local-funding", date: "2025-02-28", amount: 1000 };
  const state = { projects: [{ id: "local-project" }], funding: [legacy], settings: {} };
  const { account, calls, writes } = createEngine({ state, respond: (name) => basicResponses[name] });
  assert.equal(await account.ACCT.manualRefresh(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.funding)), [legacy]);
  assert.deepEqual(writes, []);
  assert.equal(calls.some(({ name }) => ["acct_import_legacy", "acct_seed_sample_data"].includes(name)), false);
});

test("faulty local saves send no payroll and partial cloud payroll identifies the surviving period", async () => {
  const first = { id: "older-pay", employeeId: "older" };
  const state = { projects: [], employees: [], payroll: [first], settings: {} };
  let engine;
  let localSaved = false;
  const finished = new Promise((resolve) => {
    engine = createEngine({
      state,
      saveEditor() {
        if (!localSaved) return false;
        state.payroll.unshift({
          id: "new-pay", employee: "Test Employee", employeeEmail: "employee@example.test",
          periodStart: "2026-01-26", periodEnd: "2026-02-08", baseSalary: 100, bonus: 10, currency: "USD",
        });
        return true;
      },
      respond(name, request) {
        if (name === "pay_upsert_employee") return { ok: true, employee: { id: "server-employee" } };
        if (name === "pay_open_period") return { ok: true, period: { id: "server-period", period_no: "LRS-TEST" } };
        if (name === "pay_add_item") {
          if (request.payload.item_type === "bonus") {
            setImmediate(resolve);
            return { error: "fixture rejection" };
          }
          return { ok: true, item: { id: "server-salary" } };
        }
        return basicResponses[name];
      },
    });
  });
  const { account, calls, messages, writes } = engine;
  account.coll0 = "payroll";
  account.id0 = null;
  assert.equal(await account.ACCT.manualRefresh(), true);
  assert.equal(await account.saveEditor(), false);
  assert.equal(calls.some(({ name }) => name === "pay_open_period"), false);
  localSaved = true;
  assert.equal(await account.saveEditor(), true);
  await finished;
  assert.equal(state.payroll[0].serverPeriodId, "server-period");
  assert.ok(writes.some((serialized) => JSON.parse(serialized).payroll[0].serverPeriodId === "server-period"));
  assert.match(messages.at(-1), /LRS-TEST \(1\/2\)/);
  assert.equal(calls.filter(({ name }) => name === "pay_add_item").length, 2);
  assert.equal(calls.find(({ name }) => name === "pay_open_period").request.payload.period_end, "2026-02-08");
});
