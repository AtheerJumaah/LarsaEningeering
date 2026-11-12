import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function verificationClient() {
  const source = readFileSync(new URL("../lib/verification.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const timers = [];
  const requests = [];
  const exports = {};
  const client = { functions: { invoke(_name, { body }) {
    return new Promise((resolve) => requests.push({ body, resolve }));
  } } };
  vm.runInNewContext(code, {
    exports,
    getSupabaseClient: () => client,
    supabaseConfigured: () => true,
    publishReportingWeekStart: () => {},
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    Date,
  });
  return { exports, timers, requests };
}

test("a slow but successful account check is accepted without bypassing verification", async () => {
  const { exports, timers, requests } = verificationClient();
  const result = exports.checkVerification({ id: "employee", email: "employee@example.invalid" });
  assert.equal(requests[0].body.op, "status");
  assert.equal(timers[0].delay, 30_000);
  // At eight seconds the old 4.5-second deadline had already rejected sign-in.
  assert.equal(timers.filter((timer) => !timer.cleared && timer.delay <= 8_000).length, 0);
  requests[0].resolve({ data: { ok: true, required: true }, error: null });
  assert.equal((await result).required, true);
  assert.equal(timers[0].cleared, true);
});

test("optional policy reads remain short and a failed security check stays closed", async () => {
  const { exports, timers, requests } = verificationClient();
  const policy = exports.loadPolicy();
  assert.equal(timers[0].delay, 4_500);
  requests[0].resolve({ data: { ok: false }, error: null });
  await policy;
  const verdict = exports.checkVerification({ id: "employee", email: "employee@example.invalid" });
  requests[1].resolve({ data: { ok: false }, error: null });
  assert.equal(await verdict, null);
});
