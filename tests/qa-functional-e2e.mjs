/* ============================================================
 * The functional QA audit runner.
 *
 *   node tests/qa-functional-e2e.mjs          # regression mode: exit 1 on any failure
 *   AUDIT=1 node tests/qa-functional-e2e.mjs  # audit mode: report everything, exit 0
 *
 * Drives the real shell (local server on 5199) and the accounting engine's
 * own isolated demo mode with the "Larsa Functional QA" fixture from
 * tests/qa-fixture.mjs. Every expectation encodes the SPEC-correct
 * behaviour, so in audit mode each ✗ is a confirmed functional defect and
 * in regression mode the same file guards the fixes.
 *
 * Nothing here touches production: the browser contexts are throwaway,
 * the server is local, and there are no Supabase credentials in scope.
 * ============================================================ */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { QA_USERS, QA_PASSWORD, QA_EXPECT, qaSeedShell, qaSeedEngine } from "./qa-fixture.mjs";

const BASE = process.env.QA_BASE || "http://127.0.0.1:5199";
const AUDIT = process.env.AUDIT === "1";
const results = [];
const check = (section, name, pass, detail = "") => {
  results.push({ section, name, pass: Boolean(pass), detail: String(detail).slice(0, 220) });
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});

/* The QA environment is hermetic: any Supabase call a configured build
 * would make is intercepted and answered locally, so a QA run can never
 * read from or write to the production project. */
async function isolate(page) {
  await page.route("**/rest/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/auth/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "qa", user: { id: "qa" } }) }));
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/realtime/v1/**", (route) => route.abort().catch(() => {}));
}

/* Fresh page with the QA fixture seeded, signed in as `who`, in `tz`. */
async function shellPage(ctxOpts, who, view) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await isolate(page);
  await page.addInitScript(qaSeedShell, { users: QA_USERS, password: QA_PASSWORD, sessionUser: who, method: "email" });
  await page.goto(`${BASE}/${view ? `?view=${view}` : ""}`, { waitUntil: "load" });
  await page.waitForTimeout(2600);
  return { ctx, page, errors };
}

/* ---------------------------------------------------------------- S1: sign-in + navigation */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: "Asia/Baghdad" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await isolate(page);
  await page.addInitScript(qaSeedShell, { users: QA_USERS, password: QA_PASSWORD });
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(1800);

  // A real password sign-in, through the form.
  await page.fill('#auth-panel input[name="email"]', "qa.super@larsaeng.test").catch(() => {});
  await page.fill('#auth-panel input[name="password"]', QA_PASSWORD).catch(() => {});
  await page.locator("#auth-panel button.auth-submit").click().catch(() => {});
  await page.waitForTimeout(3400);
  const signedIn = await page.evaluate(() => Boolean(document.querySelector(".unified-app")) && !document.querySelector("#auth-panel"));
  check("S1", "password sign-in reaches the shell", signedIn);

  // Home: exactly six equal module cards for a full-access account.
  const home = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".home-scroll .module-grid:not(.quick-grid):not(.accounting-grid) .module-bubble .module-copy b")].map((b) => b.textContent),
    pins: document.querySelectorAll(".home-scroll .module-grid.quick-grid .module-bubble").length,
  }));
  check("S1", "Home shows the six module cards", home.cards.length === 6, home.cards.join(" | "));

  // Walk every sidebar item to a fixpoint: choosing an item can switch the
  // channel and reveal new groups, so keep going until no unvisited label
  // remains. Every visited item must activate a view.
  const sweep = await page.evaluate(async () => {
    const out = { opened: 0, dead: [], visited: [] };
    const seen = new Set();
    let guard = 0;
    while (guard++ < 60) {
      const items = [...document.querySelectorAll("aside.sidebar .nav-item")];
      const fresh = items.find((item) => {
        const label = (item.querySelector("b") || item).textContent.trim();
        return label && !seen.has(label);
      });
      if (!fresh) break;
      const label = (fresh.querySelector("b") || fresh).textContent.trim();
      seen.add(label);
      out.visited.push(label);
      fresh.click();
      await new Promise((r) => setTimeout(r, 380));
      const active = document.querySelector(".native.active, iframe.active, .engine-frame.active, .native-scroll");
      if (active) out.opened++;
      else out.dead.push(label);
    }
    return out;
  });
  check("S1", "every sidebar item opens a view", sweep.opened > 0 && sweep.dead.length === 0,
    `opened ${sweep.opened}, dead: ${sweep.dead.join(", ") || "none"}`);
  check("S1", "no page errors during the sweep", errors.length === 0, errors.slice(0, 3).join(" ; "));
  await ctx.close();
}

/* ---------------------------------------------------------------- S2: role gating */
{
  const views = {};
  for (const who of ["zz-qa-emp", "zz-qa-view", "zz-qa-acct"]) {
    const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, who);
    views[who] = await page.evaluate(() => ({
      cards: [...document.querySelectorAll(".home-scroll .module-grid:not(.quick-grid):not(.accounting-grid) .module-bubble .module-copy b")].map((b) => b.textContent),
      navLabels: [...document.querySelectorAll("aside.sidebar .nav-item b")].map((b) => b.textContent),
      quick: [...document.querySelectorAll(".quick-action-row button")].map((b) => b.textContent.trim()),
    }));
    await ctx.close();
  }
  const emp = views["zz-qa-emp"], viewer = views["zz-qa-view"], acct = views["zz-qa-acct"];
  // Engineers legitimately reach parts of accounting (materials, labor) —
  // what they must never see is Administration or anyone's payroll.
  check("S2", "an engineer sees no Administration and no payroll surfaces",
    !emp.cards.some((c) => /Administration/.test(c))
      && !emp.navLabels.some((l) => /Payroll Portal|Sales Commissions/.test(l)),
    emp.cards.join(" | "));
  check("S2", "a viewer gets a read-only slice (no admin, no payroll)",
    !viewer.cards.some((c) => /Administration/.test(c))
      && !viewer.navLabels.some((l) => /Payroll Portal|Sales Commissions/.test(l)),
    viewer.cards.join(" | "));
  check("S2", "the accountant sees Accounting but not Administration",
    acct.cards.some((c) => /Accounting/.test(c)) && !acct.cards.some((c) => /Administration/.test(c)), acct.cards.join(" | "));
}

/* ---------------------------------------------------------------- S3: attendance numbers */
async function hoursFor(page, employeeName, from, to) {
  await page.evaluate(([f, t]) => {
    const inputs = [...document.querySelectorAll(".native.active .history-filters input[type=date]")];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    if (inputs[0]) { set.call(inputs[0], f); inputs[0].dispatchEvent(new Event("input", { bubbles: true })); inputs[0].dispatchEvent(new Event("change", { bubbles: true })); }
    if (inputs[1]) { set.call(inputs[1], t); inputs[1].dispatchEvent(new Event("input", { bubbles: true })); inputs[1].dispatchEvent(new Event("change", { bubbles: true })); }
  }, [from, to]);
  await page.waitForTimeout(700);
  return page.evaluate((name) => {
    const row = [...document.querySelectorAll(".native.active .report-panel .data-table tbody tr")]
      .find((tr) => (tr.querySelector("td b") || {}).textContent === name);
    if (!row) return null;
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent.trim());
    return { hours: Number(cells[2]), sessions: Number(cells[3]) };
  }, employeeName);
}

{
  const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-super", "performance-history");
  // Scope up so every QA account is visible.
  await page.evaluate(() => {
    const company = [...document.querySelectorAll(".native.active .scope-switch button")]
      .find((b) => /company|everyone/i.test(b.textContent));
    if (company) company.click();
  });
  await page.waitForTimeout(600);

  const day8 = await hoursFor(page, "QA Employee One", "2026-07-20", "2026-07-20");
  check("S3", "09:00–17:00 reads exactly 8.00 h on its day", day8 && day8.hours === 8, JSON.stringify(day8));

  const breakDay = await hoursFor(page, "QA Employee One", "2026-07-23", "2026-07-23");
  check("S3", "the break day reads 7.00 h net of its 1 h break", breakDay && breakDay.hours === 7, JSON.stringify(breakDay));

  const night1 = await hoursFor(page, "QA Employee One", "2026-07-21", "2026-07-21");
  const night2 = await hoursFor(page, "QA Employee One", "2026-07-22", "2026-07-22");
  check("S3", "22:00–02:00 lands 2 h on the first day", night1 && night1.hours === 2, JSON.stringify(night1));
  check("S3", "22:00–02:00 lands 2 h on the second day", night2 && night2.hours === 2, JSON.stringify(night2));

  const whole = await hoursFor(page, "QA Employee One", "2026-07-20", "2026-07-23");
  check("S3", "the week range still sums the same sessions once (19 h)", whole && Math.abs(whole.hours - 19) < 0.01, JSON.stringify(whole));

  const early = await hoursFor(page, "QA Early Bird", "2026-07-25", "2026-07-25");
  check("S3", "a 00:30–06:30 local session lands on its own local day", early && early.hours === 6, JSON.stringify(early));

  const year25 = await hoursFor(page, "QA Year Boundary", "2025-12-31", "2025-12-31");
  const year26 = await hoursFor(page, "QA Year Boundary", "2026-01-01", "2026-01-01");
  check("S3", "Dec 31 22:00 → Jan 1 01:00 splits 2 h / 1 h across the year line",
    year25 && year25.hours === 2 && year26 && year26.hours === 1, JSON.stringify({ year25, year26 }));

  const dupe = await hoursFor(page, "QA Duplicate Punch", "2026-07-24", "2026-07-24");
  check("S3", "a double clock-in never loses the first press (10:00–11:00 = 1.00 h)",
    dupe && dupe.hours === 1, JSON.stringify(dupe));

  // The stale session: never silently part of the totals, still open, flagged.
  const staleNow = await hoursFor(page, "QA Stale Session", "2020-01-01", "2030-01-01");
  check("S3", "a 72 h open session is not silently counted into totals",
    staleNow && staleNow.hours < QA_EXPECT.staleAfterHours, JSON.stringify(staleNow));
  const staleState = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
    const logs = (store.logs || []).filter((l) => l.uid === "zz-qa-stale");
    return { ins: logs.filter((l) => l.status === "In").length, outs: logs.filter((l) => l.status === "Out").length };
  });
  check("S3", "the stale session was never auto-closed", staleState.ins === 1 && staleState.outs === 0, JSON.stringify(staleState));
  const staleFlag = await page.evaluate(() =>
    /stale|needs correction|check this session/i.test((document.querySelector(".native.active") || {}).textContent || ""));
  check("S3", "the stale session is flagged for correction somewhere visible", staleFlag);

  // The on-screen table and its CSV export must tell the same story.
  await page.evaluate(([f, t]) => {
    const inputs = [...document.querySelectorAll(".native.active .history-filters input[type=date]")];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    [f, t].forEach((v, i) => { if (inputs[i]) { set.call(inputs[i], v); inputs[i].dispatchEvent(new Event("input", { bubbles: true })); inputs[i].dispatchEvent(new Event("change", { bubbles: true })); } });
  }, ["2026-07-20", "2026-07-20"]);
  await page.waitForTimeout(600);
  const csvWait = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".native.active button")].find((b) => /Export Records/.test(b.textContent || ""));
    if (btn) btn.click();
  });
  const csvFile = await csvWait;
  let csv = "";
  if (csvFile) {
    const { readFileSync } = await import("node:fs");
    csv = readFileSync(await csvFile.path(), "utf8");
  }
  const csvHours = csv.split("\n").slice(1).filter((l) => /QA Employee One/.test(l))
    .reduce((sum, l) => {
      const cells = l.trim().replace(/^"|"$/g, "").split('","');
      return sum + (Number(cells[3]) || 0);
    }, 0);
  check("S3", "the timesheet CSV agrees with the screen: 8.00 h that day",
    Boolean(csvFile) && Math.abs(csvHours - 8) < 0.01, `csv hours ${csvHours}`);

  await ctx.close();

  // The ghost: a raw id must never stand in for a person's name. The trim
  // panel lists sessions straight from the logs, so it is the surface that
  // would leak the id.
  const qc = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-super", "quick-clock");
  const ghost = await qc.page.evaluate(async () => {
    const open = [...document.querySelectorAll(".native.active button")].find((b) => /Trim or remove recorded hours/.test(b.textContent || ""));
    if (!open) return { noPanel: true };
    open.click();
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll(".native.active .trim-row .trim-who b")].map((b) => b.textContent);
    return {
      rows: rows.slice(0, 20),
      rawId: rows.some((r) => r === "zz-qa-ghost"),
      readable: rows.some((r) => /former|ghost/i.test(r) && r !== "zz-qa-ghost"),
    };
  });
  check("S3", "a session by a removed account shows a readable label, not the raw id",
    ghost.rawId === false && ghost.readable === true, JSON.stringify(ghost));
  await qc.ctx.close();

  // Same 8-hour day, from Texas: duration identical in a different timezone.
  const tx = await shellPage({ timezoneId: "America/Chicago" }, "zz-qa-super", "performance-history");
  await tx.page.evaluate(() => {
    const company = [...document.querySelectorAll(".native.active .scope-switch button")]
      .find((b) => /company|everyone/i.test(b.textContent));
    if (company) company.click();
  });
  await tx.page.waitForTimeout(600);
  const txDay = await hoursFor(tx.page, "QA Employee One", "2026-07-20", "2026-07-20");
  check("S3", "the same day reads 8.00 h from US Central too", txDay && txDay.hours === 8, JSON.stringify(txDay));
  await tx.ctx.close();
}

/* ---------------------------------------------------------------- S4: leave + corrections */
{
  const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-emp", "my-requests");
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".native.active table tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent.trim())));
  const leaveRow = rows.find((r) => r.some((c) => /Annual/.test(c)));
  const corrRow = rows.find((r) => r.some((c) => /Missed Clock/.test(c)));
  check("S4", "a three-day leave shows 3 days", Boolean(leaveRow && leaveRow.some((c) => /^3( days?)?$/.test(c))), JSON.stringify(leaveRow));
  check("S4", "a 09:00–12:00 correction never displays as zero",
    Boolean(corrRow) && !corrRow.some((c) => /^0( days?)?$/.test(c)) && corrRow.some((c) => /3\s*h|09:00.*12:00/.test(c)),
    JSON.stringify(corrRow));
  await ctx.close();
}

/* ---------------------------------------------------------------- S5: performance points */
{
  const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-emp");
  await page.waitForTimeout(900);
  const reminder = await page.evaluate(() => {
    const scroll = document.querySelector(".home-scroll");
    const text = scroll ? scroll.textContent || "" : "";
    const hit = /Weekly points([^•]*?awaiting review|[^•]*?target)/.exec(text);
    return { present: /15 approved of 50 target/.test(text), around: hit ? hit[0].slice(0, 120) : text.slice(0, 80) };
  });
  check("S5", "official score is approved-only: 15 approved of 50 target",
    reminder.present, reminder.around);
  await ctx.close();

  const mgr = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-mgr", "performance-center");
  const centre = await mgr.page.evaluate(() => {
    const row = [...document.querySelectorAll(".native.active table tbody tr")]
      .find((tr) => /QA Employee One/.test(tr.textContent));
    return row ? row.textContent : null;
  });
  check("S5", "the manager's centre agrees: approved 15, completion 30%",
    Boolean(centre) && /15/.test(centre) && /30%/.test(centre), centre || "employee row not found");
  await mgr.ctx.close();
}

/* ---------------------------------------------------------------- S6: the accounting engine (isolated demo) */
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, timezoneId: "Asia/Baghdad" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await isolate(page);
  await page.addInitScript(qaSeedEngine);
  await page.goto(BASE + "/engines/accounting.html?demo=1", { waitUntil: "load" });
  await page.waitForTimeout(1500);

  const banner = await page.evaluate(() => /ISOLATED DEMO/.test(document.body.textContent || ""));
  check("S6", "the engine announces itself as an isolated demo", banner);

  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("loginEmail", "qa.owner@larsaeng.test");
    set("loginPass", "qa-owner-pass-2026");
    if (typeof window.doLogin === "function") window.doLogin();
  });
  await page.waitForTimeout(1200);
  const inApp = await page.evaluate(() => {
    const app = document.getElementById("app");
    return Boolean(app && app.style.display !== "none");
  });
  check("S6", "the QA owner signs into the demo engine", inApp);

  const totals = await page.evaluate(() => {
    try { return window.xTotals ? xTotals("zz-qa-prj1") : null; } catch (e) { return { err: String(e) }; }
  });
  const near = (a, b) => a != null && Math.abs(a - b) < 0.02;
  // The engine keeps project totals in USD at each line's recorded 1500 rate.
  check("S6", "project totals honour the recorded rate: net funding 92M (61,333.33 USD)",
    totals && near(totals.netFunding, 61333.33), JSON.stringify(totals && { net: totals.netFunding }));
  check("S6", "actual cost is materials + labor only: 30M (20,000 USD)",
    totals && near(totals.mat + totals.lab, 20000) && near(totals.total, 20000),
    JSON.stringify(totals && { mat: totals.mat, lab: totals.lab, total: totals.total }));
  check("S6", "the pending 5M stays out of actuals and in pending (3,333.33 USD)",
    totals && near(totals.pending, 3333.33) && near(totals.exp, 0),
    JSON.stringify(totals && { pending: totals.pending, exp: totals.exp }));
  check("S6", "remaining balance is 62M (41,333.33 USD)",
    totals && near(totals.balance, 41333.33), JSON.stringify(totals && { balance: totals.balance }));
  check("S6", "the fee is charged once: 8M (5,333.33 USD)",
    totals && near(totals.fee, 5333.33), JSON.stringify(totals && { fee: totals.fee }));

  const fx = await page.evaluate(() => {
    const t = xTotals("zz-qa-prj2");
    return { gross: t.gross };
  });
  check("S6", "two $1,000 payments at 1500 and 1600 total exactly $2,000", near(fx.gross, 2000), JSON.stringify(fx));

  // Reports and exports must not re-price history at today's rate. The
  // report window is widened to the year so the July fixture is in scope.
  const reportDrift = await page.evaluate(() => {
    if (typeof reportData !== "function") return { missing: true };
    rptPreset = "year";
    const before = reportData();
    const old = state.settings.rate;
    state.settings.rate = 1400;
    const after = reportData();
    state.settings.rate = old;
    const pick = (r) => ({ fee: r.feeUSD, exp: r.expUSD, net: r.netConstruction, pay: r.payUSD });
    return { same: JSON.stringify(pick(before)) === JSON.stringify(pick(after)), before: pick(before), after: pick(after) };
  });
  check("S6", "changing today's rate never rewrites report history", reportDrift.same === true, JSON.stringify(reportDrift));

  const payroll = await page.evaluate(() => {
    const row = state.payroll.find((r) => r.id === "zz-qa-pay1");
    deriveRecord("payroll", row);
    return { gross: row.gross, net: row.net };
  });
  check("S6", "payroll: 2,000,000 + 500,000 + 200,000 − 100,000 → gross 2,700,000",
    payroll.gross === QA_EXPECT.payGross, JSON.stringify(payroll));
  check("S6", "payroll: net pays 2,600,000", payroll.net === QA_EXPECT.payNet, JSON.stringify(payroll));

  // Paid payroll must be immutable and the paid switch permission-gated.
  const paidGuard = await page.evaluate(() => {
    const row = state.payroll.find((r) => r.id === "zz-qa-pay1");
    row.status = "Paid";
    const before = JSON.stringify(row);
    const engineer = state.users.find((u) => u.role === "Engineer");
    const real = currentUser;
    currentUser = engineer;
    let flipped = null;
    try { x33PaidPayroll("zz-qa-pay1"); flipped = state.payroll.find((r) => r.id === "zz-qa-pay1").paidBy || null; } catch (e) { flipped = null; }
    currentUser = real;
    const guarded = flipped !== (engineer && engineer.email);
    let editorOpened = false;
    try {
      openEditor("payroll", "zz-qa-pay1");
      editorOpened = Boolean(document.querySelector("#modalRoot .modal, #modalRoot form, #modalRoot .modal-card"));
      if (typeof closeEditor === "function") closeEditor();
    } catch (e) { editorOpened = false; }
    const row2 = state.payroll.find((r) => r.id === "zz-qa-pay1");
    const unchanged = JSON.stringify(row2) === before;
    return { guarded, editorOpened, unchanged };
  });
  check("S6", "only an authorised role can mark a run Paid", paidGuard.guarded, JSON.stringify(paidGuard));
  check("S6", "a Paid payroll row cannot be edited in place", !paidGuard.editorOpened, JSON.stringify(paidGuard));

  // The linked-add workflow: the project prefills, and cancelling must
  // release the lock so the NEXT plain entry is free to choose its project.
  const lockLeak = await page.evaluate(async () => {
    if (typeof window.addLinked310 !== "function") return { missing: true };
    addLinked310("expenses", "zz-qa-prj1");
    await new Promise((r) => setTimeout(r, 250));
    const select = document.getElementById("ed_projectId");
    const opened = Boolean(select);
    const prefilled = select ? select.value === "zz-qa-prj1" : false;
    if (typeof closeEditor === "function") closeEditor();
    await new Promise((r) => setTimeout(r, 120));
    return { opened, prefilled, leak: window.__larsaReturnProjectId || null };
  });
  check("S6", "a linked add opens with the project preselected",
    lockLeak.opened === true && lockLeak.prefilled === true, JSON.stringify(lockLeak));
  check("S6", "cancelling a project-locked entry releases the lock",
    lockLeak.opened === true && lockLeak.leak == null, JSON.stringify(lockLeak));

  // An edited form must not vanish on a stray backdrop click.
  const dirtyGuard = await page.evaluate(async () => {
    if (typeof window.openEditor !== "function") return { missing: true };
    openEditor("expenses");
    await new Promise((r) => setTimeout(r, 150));
    const field = document.querySelector('#modalRoot input[id^="ed_"], #modalRoot textarea');
    if (field) { field.value = "QA unsaved text"; field.dispatchEvent(new Event("input", { bubbles: true })); }
    let asked = false;
    const oldConfirm = window.confirm;
    window.confirm = () => { asked = true; return false; };
    // The backdrop is .modal-back; its onclick closes only when the click
    // lands on the backdrop itself, which a direct click() does.
    const backdrop = document.querySelector("#modalRoot .modal-back");
    if (backdrop) backdrop.click();
    await new Promise((r) => setTimeout(r, 100));
    const stillOpen = Boolean(document.querySelector("#modalRoot .modal"));
    window.confirm = oldConfirm;
    if (stillOpen) { setHTML("modalRoot", ""); document.body.classList.remove("modal-open"); }
    return { asked, stillOpen, hadBackdrop: Boolean(backdrop) };
  });
  check("S6", "clicking away from an edited form asks before discarding",
    dirtyGuard.asked === true || dirtyGuard.stillOpen === true, JSON.stringify(dirtyGuard));

  check("S6", "no page errors in the engine", errors.length === 0, errors.slice(0, 3).join(" ; "));
  await ctx.close();
}

/* ---------------------------------------------------------------- S7: backups carry no credentials */
{
  const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-super", "data");
  const download = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await page.evaluate(() => {
    const btn = document.querySelector(".backup-scope.staff") || document.querySelector(".backup-scope.all")
      || [...document.querySelectorAll(".native.active button")].find((b) => /export|backup|download/i.test(b.textContent || ""));
    if (btn) btn.click();
  });
  const file = await download;
  let body = "";
  if (file) {
    const path = await file.path();
    const { readFileSync } = await import("node:fs");
    body = readFileSync(path, "utf8");
  }
  check("S7", "a staff backup downloads", Boolean(file), file ? "downloaded" : "no download event");
  check("S7", "the backup carries no passwords or PINs", body.length > 0 && !body.includes(QA_PASSWORD) && !/"password"\s*:/.test(body) && !/"pin"\s*:/.test(body),
    body ? `${body.length} bytes` : "empty");
  await ctx.close();

  // The engine's own backup, same rule.
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page2 = await ctx2.newPage();
  await isolate(page2);
  await page2.addInitScript(qaSeedEngine);
  await page2.goto(BASE + "/engines/accounting.html?demo=1", { waitUntil: "load" });
  await page2.waitForTimeout(1200);
  await page2.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("loginEmail", "qa.owner@larsaeng.test"); set("loginPass", "qa-owner-pass-2026");
    if (typeof window.doLogin === "function") window.doLogin();
  });
  await page2.waitForTimeout(800);
  const dl2 = page2.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await page2.evaluate(() => { if (typeof window.exportBackup === "function") exportBackup(); });
  const file2 = await dl2;
  let body2 = "";
  if (file2) {
    const { readFileSync } = await import("node:fs");
    body2 = readFileSync(await file2.path(), "utf8");
  }
  check("S7", "the accounting backup carries no credentials or keys",
    body2.length > 0 && !/qa-owner-pass-2026/.test(body2) && !/"pass(Hash|Salt)?"\s*:/.test(body2) && !/supabase(Url|AnonKey)/i.test(body2),
    body2 ? `${body2.length} bytes` : "no download");
  await ctx2.close();
}

/* ---------------------------------------------------------------- S8: reliability + a11y */
{
  const { ctx, page } = await shellPage({ timezoneId: "Asia/Baghdad" }, "zz-qa-emp", "quick-clock");
  // Double-press: two rapid taps on Clock In must produce ONE In and no Out.
  const doublePress = await page.evaluate(async () => {
    const before = (JSON.parse(localStorage.getItem("larsaStaffV8") || "{}").logs || [])
      .filter((l) => l.uid === "zz-qa-emp").length;
    const btn = [...document.querySelectorAll(".native.active button")]
      .find((b) => /clock in/i.test(b.textContent || ""));
    if (!btn) return { missing: true };
    btn.click(); btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const logs = (JSON.parse(localStorage.getItem("larsaStaffV8") || "{}").logs || [])
      .filter((l) => l.uid === "zz-qa-emp");
    const added = logs.slice(before);
    return { ins: added.filter((l) => l.status === "In").length, outs: added.filter((l) => l.status === "Out").length };
  });
  check("S8", "a double-tap on Clock In files one punch, not an instant in-out",
    doublePress.ins === 1 && doublePress.outs === 0, JSON.stringify(doublePress));

  // Mobile: no sideways scroll on the Home screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(1800);
  const mobile = await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  }));
  check("S8", "phone-width Home has no sideways scroll", !mobile.sideways, JSON.stringify(mobile));
  await ctx.close();
}

await browser.close();

/* ---------------------------------------------------------------- report */
let failed = 0;
let section = "";
for (const r of results) {
  if (r.section !== section) { section = r.section; console.log(`\n== ${section} ==`); }
  const mark = r.pass ? "✓" : "✗";
  if (!r.pass) failed++;
  console.log(` ${mark} ${r.name}${r.pass ? "" : `   [${r.detail}]`}`);
}
console.log(`\n${results.length - failed}/${results.length} checks pass${failed ? `, ${failed} FAILING` : ""}`);
process.exit(AUDIT ? 0 : failed ? 1 : 0);
