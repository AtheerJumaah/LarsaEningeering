/* Browser regression for the accounting engine's offline storage and backups.
 * Run with node tests/accounting-storage.smoke.mjs. PLAYWRIGHT_MODULE and
 * CHROME_PATH may point to an existing Playwright and Chrome installation. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const chrome = process.env.CHROME_PATH || [
  join(process.env.ProgramFiles || "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  "/opt/pw-browsers/chromium",
].find(existsSync);
const browser = await chromium.launch({ executablePath: chrome });
const origin = "http://accounting-storage.test";
const storeKey = "larsa_enterprise_v3_new_account_20260630_v34_clean";
const fixture = {
  settings: {}, audit: [],
  users: [{ id: "fixture-user", email: "fixture@example.invalid", passHash: "fixture-hash", passSalt: "fixture-salt", passIterations: 2 }],
  projects: [{ id: "p1", region: "Iraq", type: "Construction", consultancyRate: 0.2 }],
  funding: [{ id: "f1", projectId: "p1", amount: 2000, date: "2026-06-01",
    consultancyRate: 0, consultancyFee: 0, netConstruction: 2000, receipt: { name: "original.pdf", ref: "original" } }],
  payroll: [
    { id: "cross-month", period: "2026-02", periodEnd: "2026-03-01", payDate: "2026-03-05" },
    { id: "leap-year", period: "2024-02" },
  ],
};

async function open(raw, timezoneId) {
  const ctx = await browser.newContext({ serviceWorkers: "block", timezoneId });
  await ctx.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !/^\/engines\/accounting(?:-core|-cloud)?\.(html|js)$/.test(url.pathname)) {
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({
      contentType: url.pathname.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      body: readFileSync(new URL("../public" + url.pathname, import.meta.url)),
    });
  });
  const page = await ctx.newPage();
  await page.addInitScript(({ key, payload }) => localStorage.setItem(key, payload), { key: storeKey, payload: raw });
  await page.goto(origin + "/engines/accounting.html?demo=1");
  return { ctx, page };
}

try {
  for (const timezone of ["Asia/Baghdad", "America/Chicago"]) {
    const raw = JSON.stringify(fixture);
    const { ctx, page } = await open(raw, timezone);
    const observed = await page.evaluate(key => ({ stored: localStorage.getItem(key),
      period: state.payroll[0].periodEnd, leap: state.payroll[1].periodEnd,
      payDate: state.payroll[0].payDate, fee: state.funding[0].consultancyFee,
      iso: localDateISO("2026-06-01"), within: inRange({ date: "2026-06-01T20:00:00Z" }, "2026-06-01", "2026-06-01"),
    }), storeKey);
    assert.deepEqual(observed, { stored: raw, period: "2026-03-01", leap: "2024-02-29",
      payDate: "2026-03-05", fee: 0, iso: "2026-06-01", within: true }, timezone);

    if (timezone === "Asia/Baghdad") {
      const backup = await page.evaluate(async key => {
        await idbPut("original", { name: "original.pdf", data: "ORIGINAL" });
        let exported;
        downloadBlob = text => { exported = JSON.parse(text); };
        await exportBackup();
        const incoming = { ...structuredClone(exported.data), funding: [
          { id: "f1", date: "2023-01-01", amount: 1 },
          { id: "f2", date: "2026-07-01", amount: 100, receipt: { ref: "original", name: "different.pdf", data: "INCOMING" } },
        ] };
        const storedBefore = localStorage.getItem(key);
        const persist = save;
        save = () => false;
        let failed = false;
        try { await applyAccountingBackup(incoming, true, "Before failed restore"); }
        catch { failed = true; }
        save = persist;
        const preserved = localStorage.getItem(key) === storedBefore && state.funding.length === 1;
        await applyAccountingBackup(incoming, false, "Before merge");
        const afterMerge = structuredClone(state.funding);
        await applyAccountingBackup(incoming, true, "Before replace");
        const afterReplace = structuredClone(state.funding);
        const restorePoint = state.restorePoints[0];
        return { exported, failed, preserved, afterMerge, afterReplace, restorePoint, user: state.users[0],
          original: await idbGet("original"), imported: await idbGet(afterReplace[1].receipt.ref) };
      }, storeKey);
      assert.equal(backup.exported.data.funding[0].receipt.data, "ORIGINAL");
      assert.equal(backup.exported.data.users[0].passHash, undefined);
      assert.equal(backup.exported.missingReceipts, 0);
      assert.equal(backup.failed, true);
      assert.equal(backup.preserved, true);
      assert.equal(backup.afterMerge[0].date, "2026-06-01");
      assert.equal(backup.afterMerge[0].amount, 2000);
      assert.equal(backup.afterReplace[0].date, "2023-01-01");
      assert.equal(backup.restorePoint.data.funding[0].date, "2026-06-01");
      assert.equal(backup.restorePoint.data.restorePoints, undefined);
      assert.equal(backup.user.passHash, "fixture-hash");
      assert.equal(backup.original.data, "ORIGINAL");
      assert.equal(backup.imported.data, "INCOMING");

      const rejectedEdit = await page.evaluate(async () => {
        window.alert = () => {};
        currentUser = { id: "test-owner", email: "test@example.invalid", role: "Owner / Super Admin" };
        const row = state.funding[0];
        row.receipt = { ref: "original", name: "original.pdf" };
        const before = JSON.stringify(row);
        openEditor("funding", row.id);
        document.getElementById("ed_amount").value = "400";
        document.getElementById("ed_fxRate").value = "0";
        edClearReceipt();
        const result = await saveEditor();
        return { result, unchanged: before === JSON.stringify(state.funding[0]), receipt: await idbGet("original") };
      });
      assert.equal(rejectedEdit.result, false);
      assert.equal(rejectedEdit.unchanged, true);
      assert.equal(rejectedEdit.receipt.data, "ORIGINAL");
    }
    await ctx.close();
  }

  const broken = '{"settings":{},"projects":[';
  const { ctx, page } = await open(broken, "Asia/Baghdad");
  const recovery = await page.evaluate(async key => {
    window.alert = () => {};
    let copy;
    downloadBlob = text => { copy = text; };
    const saved = save();
    await exportBackup();
    return { saved, copy, raw: localStorage.getItem(key) };
  }, storeKey);
  assert.deepEqual(recovery, { saved: false, copy: broken, raw: broken });
  await ctx.close();

  const { ctx: shared, page: stale } = await open(JSON.stringify(fixture), "America/Chicago");
  const recent = await shared.newPage();
  await recent.goto(origin + "/engines/accounting.html?demo=1");
  const restore = stale.evaluate(async key => {
    window.storageConflictMessages = [];
    window.alert = message => window.storageConflictMessages.push(message);
    const before = JSON.stringify(state);
    const backup = { ...structuredClone(state), funding: [{ id: "restore-funding", date: "2023-08-31",
      receipt: { name: "restore.pdf", data: "BACKUP" } }] };
    const writeReceipt = idbPut;
    let stagedReceipt;
    idbPut = async (ref, receipt) => {
      stagedReceipt = ref;
      await new Promise(resolve => { window.resumeRestoreReceipt = resolve; });
      return writeReceipt(ref, receipt);
    };
    let rejected = false;
    try { await applyAccountingBackup(backup, true, "Before concurrent restore"); }
    catch { rejected = true; }
    finally { idbPut = writeReceipt; }
    return { rejected, stateUnchanged: JSON.stringify(state) === before,
      stored: localStorage.getItem(key), stagedReceipt: await idbGet(stagedReceipt) };
  }, storeKey);
  await stale.waitForFunction(() => typeof window.resumeRestoreReceipt === "function");
  const latest = await recent.evaluate(key => {
    state.funding.push({ id: "newer-funding", date: "2024-02-29", amount: 350 });
    return { saved: save(), raw: localStorage.getItem(key) };
  }, storeKey);
  assert.equal(latest.saved, true);
  await stale.evaluate(() => { window.resumeRestoreReceipt(); });
  assert.deepEqual(await restore, { rejected: true, stateUnchanged: true, stored: latest.raw, stagedReceipt: null });
  const staleEdit = await stale.evaluate(async key => {
    const before = JSON.stringify(state.funding);
    currentUser = { id: "test-owner", email: "test@example.invalid", role: "Owner / Super Admin" };
    openEditor("funding", "f1");
    document.getElementById("ed_amount").value = "400";
    document.getElementById("ed_fxRate").value = "1500";
    const saved = await saveEditor();
    return { saved, stateUnchanged: JSON.stringify(state.funding) === before, stored: localStorage.getItem(key),
      messages: window.storageConflictMessages };
  }, storeKey);
  assert.equal(staleEdit.saved, false);
  assert.equal(staleEdit.stateUnchanged, true);
  assert.equal(staleEdit.stored, latest.raw);
  assert.equal(staleEdit.messages.filter(message => /another tab/i.test(message)).length, 2);
  assert.equal(JSON.parse(latest.raw).funding.find(row => row.id === "newer-funding").date, "2024-02-29");
  await shared.close();

  console.log("Accounting dates, backup receipts, restore atomicity, stale-tab protection, editor validation, and corrupt storage passed.");
} finally {
  await browser.close();
}
