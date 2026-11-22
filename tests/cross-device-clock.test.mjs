import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsx from "react/jsx-runtime";
import { resolveClockDisplay } from "../lib/attendance-display.mjs";
import { OPEN_SESSION_STALE_HOURS } from "../lib/attendance.mjs";

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const clock = page.slice(page.indexOf("function QuickClock("));
const compute = clock.slice(clock.indexOf("  const pendingActions:"), clock.indexOf("  useEffect(() => {", clock.indexOf("  const pendingActions:")));
const hero = clock.slice(clock.indexOf('<section className="overview-hero'), clock.indexOf("</section>", clock.indexOf('<section className="overview-hero')) + 10);
const button = clock.slice(clock.indexOf('<button', clock.indexOf("Saving the clock action locally")), clock.indexOf('</button>', clock.indexOf("Saving the clock action locally")) + 9);
const source = ts.transpileModule("function surface(){ " + compute + "\nconst actionMode=displayClock.mode||mode; const punchAvailable=!checkingClock; return <>{ " + hero + " }{ " + button + " }</> }", {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: "surface.tsx",
}).outputText;
const now = Date.parse("2024-02-12T08:00Z");
const previous = { id: "first", uid: "employee", type: "Office", status: "In", time: "2024-02-11T08:15Z" };
function surface(punch, opts = {}) {
  const context = {
    resolveClockDisplay, OPEN_SESSION_STALE_HOURS, require: () => jsx, exports: {},
    useMemo: (f) => f(), readAttendanceQueue: () => opts.queue || [], attendancePunchQueueKey: () => "queue",
    user: { id: "employee", name: "Employee" }, summary: { openClock: opts.open || null },
    connection: "online", logs: [previous], clockRecord: { state: opts.state || "confirmed", punch },
    mode: "Office", pendingNeedsRetry: false, punching: false, serverNowMs: () => now,
    greeting: () => "Hello", modeTone: () => "office", attendanceTime: (v) => v,
    Timer: () => null, Radio: () => null,
  };
  const output = vm.runInNewContext(source + "\nsurface()", context);
  return renderToStaticMarkup(output);
}
test("a missing clock-out never renders Off the clock beside Clock Out", () => {
  const html = surface(previous);
  assert.match(html, /Missing clock-out/);
  assert.match(html, />Clock Out<\/button>/);
  assert.doesNotMatch(html, /Off the clock/);
});
test("confirmed cross-device clock-out overrides a stale open shift and old pending clock-in", () => {
  const html = surface({ ...previous, status: "Out", time: "2024-02-12T07:00Z" }, {
    open: { clockIn: previous.time, mode: "Office" },
    queue: [{ uid: "employee", status: "In", occurred_at: previous.time }],
  });
  assert.match(html, /Off the clock/);
  assert.match(html, />Clock In<\/button>/);
  assert.doesNotMatch(html, /On the clock|pending synchronization/);
});
test("confirmed clock-in, an unconfirmed phone tap, and an unavailable status are distinct", () => {
  const active = { ...previous, time: "2024-02-12T06:00Z" };
  assert.match(surface(active), /On the clock.*Clock Out/s);
  const pending = surface(active, { queue: [{ uid: "employee", status: "Out", occurred_at: "2024-02-12T07:00Z" }] });
  assert.match(pending, /Clock out pending synchronization/);
  assert.doesNotMatch(pending, /Off the clock/);
  assert.match(surface(null, { state: "unavailable" }), /Unconfirmed.*disabled.*Awaiting clock status/s);
  assert.match(surface(null, { open: { mode: "Office", clockIn: previous.time } }), /Off the clock.*Clock In/s);
});

const hook = fs.readFileSync(new URL("../lib/use-clock-record.ts", import.meta.url), "utf8");
const hookJs = ts.transpileModule(hook, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function device(read, timeoutMs) {
  let record, cleanup, interval, last;
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const win = Object.assign(new EventTarget(), {
    setTimeout: (f, delay) => setTimeout(f, timeoutMs ?? delay), clearTimeout,
    clearInterval() {}, setInterval(f) { interval = f; return 1; },
  });
  const react = { useRef: (v) => ({ current: v }), useCallback: (f) => f,
    useEffect: (f) => { cleanup = f(); }, useState: () => [record, v => { record = typeof v === "function" ? v(record) : v; }] };
  const client = { rpc(name, args) {
    assert.equal(name, "latest_attendance_shift"); assert.equal(args.p_uid, "employee");
    return { abortSignal: () => ({ maybeSingle: () => (last = read()) }) };
  } };
  const exports = {};
  vm.runInNewContext(hookJs, { exports, window: win, document: doc, AbortController,
    require: name => name === "react" ? react : { getSupabaseClient: () => client } });
  const { refresh } = exports.useClockRecord("employee", true);
  return { refresh, win, doc, poll: () => interval(), get record() { return record; },
    settled: async () => { await last; await new Promise(resolve => setImmediate(resolve)); },
    stop: () => cleanup() };
}
test("two devices converge after clock-out, missed realtime, background resume and reconnection", async () => {
  let row = { id: "1", status: "In", occurred_at: previous.time, work_mode: "Office" };
  const read = async () => ({ data: row, error: null });
  const phone = device(read), laptop = device(read);
  try {
    await Promise.all([phone.settled(), laptop.settled()]);
    assert.equal(laptop.record.punch.status, "In");
    laptop.doc.hidden = true; laptop.doc.dispatchEvent(new Event("visibilitychange"));
    row = { ...row, id: "2", status: "Out", occurred_at: "2024-02-12T07:00Z" };
    await phone.refresh();
    laptop.poll();
    assert.equal(laptop.record.state, "checking");
    laptop.doc.hidden = false; laptop.win.dispatchEvent(new Event("pageshow"));
    await laptop.settled();
    assert.equal(laptop.record.punch.status, phone.record.punch.status);
    row = { ...row, id: "3", status: "In", occurred_at: "2024-02-12T07:30Z" };
    laptop.poll(); await laptop.settled(); assert.equal(laptop.record.punch.status, "In");
    phone.win.dispatchEvent(new Event("online")); await phone.settled(); assert.equal(phone.record.punch.id, "3");
  } finally { phone.stop(); laptop.stop(); }
});
test("a late response cannot restore a previous clock-in after the newer clock-out was read", async () => {
  let release;
  const d = device(() => new Promise(resolve => { release = resolve; }));
  const old = release, newest = d.refresh();
  release({ data: { id: "b", status: "Out", occurred_at: "2024-02-12T07:00Z" } });
  await newest;
  old({ data: { id: "a", status: "In", occurred_at: previous.time } }); await Promise.resolve();
  assert.equal(d.record.punch.status, "Out"); d.stop();
});

test("a stalled read becomes unconfirmed and the next poll can recover", async () => {
  let stalled = true;
  const d = device(() => stalled ? new Promise(() => {}) : Promise.resolve({ data: null }), 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(d.record.state, "unavailable");
    stalled = false;
    d.poll();
    await d.settled();
    assert.equal(d.record.state, "confirmed");
    assert.equal(d.record.punch, null);
  } finally { d.stop(); }
});
