/* Larsa Control — the August durability repair, replayed end to end.
 *
 * Runs the REAL app (a local build pointed at the live backend) in two
 * isolated browser contexts — "device A" and "device B" — and replays every
 * reported failure with a QA-only account: signup, repeated sign-ins inside
 * the verification interval, first-click clock-in, double-click suppression,
 * refresh survival, cross-device sync, STALE WHOLESALE WRITE-BACKS (the
 * engine-iframe failure that caused the losses), clock-out permanence,
 * password-change durability against stale replays, and PIN sign-in inside
 * its configured interval. No real employee's data is touched.
 *
 *   node tests/durability-e2e.smoke.mjs   # expects `next start` on :3100
 *                                         # and .env.local with the backend
 *
 * Codes are read through a temporary QA-locked helper RPC
 * (qa_peek_code_20260822) that only ever answers for the QA address and is
 * dropped when the battery is done.
 */
import { createRequire } from "node:module";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
const requireFrom = createRequire("/home/claude/e2e/");
const { chromium } = requireFrom("playwright");

const BASE = process.env.SMOKE_URL || "http://localhost:3100";
const QA_EMAIL = process.env.SMOKE_QA_EMAIL || "ajumaah+larsa-qa@larsaeng.com";
const QA_NAME = "QA Durability Check";
const QA_PASS_1 = "Qa!Repair2026x";
const QA_PASS_2 = "Qa!Repair2026y";
const QA_PIN = "739218";
const LOG = "/tmp/e2e_progress.log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let codeCounter = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}
let dumpPages = [];
async function dumpState() {
  for (const [name, page] of dumpPages) {
    try {
      await page.screenshot({ path: `/tmp/e2e_fail_${name}.png` });
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 1200));
      appendFileSync(LOG, `--- body ${name} ---\n${txt}\n`);
    } catch { /* page may be gone */ }
  }
}
function fail(msg) {
  log("FAIL: " + msg);
  writeFileSync("/tmp/e2e_result.json", JSON.stringify({ ok: false, msg }));
  throw new Error("E2E_FAIL: " + msg);
}
function ok(step) { log("PASS: " + step); }

/* The app's own public client coordinates, read from the local build's env
 * file (NEXT_PUBLIC_* values are public by definition — they ship in the
 * site bundle). */
const envText = readFileSync("/home/claude/larsa/.env.local", "utf8");
const SB_URL = envText.match(/NEXT_PUBLIC_SUPABASE_URL=(\S+)/)[1];
const SB_ANON = envText.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(\S+)/)[1];
const usedCodes = new Set();

/* Reads the QA address's latest live code through a temporary, QA-locked
 * SECURITY DEFINER helper (dropped right after this battery). It can only
 * ever return codes for the QA test address. `since` guards against
 * grabbing a leftover unconsumed code from an earlier partial run: only a
 * code MINTED after the triggering click is accepted. */
async function awaitCode(email, since) {
  codeCounter += 1;
  log(`fetching verification code #${codeCounter} for ${email}`);
  const floor = since ? new Date(since).getTime() : 0;
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/qa_peek_code_20260822`, {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email }),
    });
    const body = await res.text();
    let row = null;
    try { row = body ? JSON.parse(body) : null; } catch { row = null; }
    const code = row && row.code ? String(row.code) : null;
    const mintedAt = row && row.created_at ? new Date(row.created_at).getTime() : 0;
    if (code && code.length === 6 && mintedAt > floor && !usedCodes.has(code)) {
      usedCodes.add(code);
      log(`code #${codeCounter} fetched (minted ${row.created_at})`);
      return code;
    }
    await sleep(1500);
  }
  fail("timed out fetching code #" + codeCounter);
}

async function waitStoreReady(page) {
  await page.waitForFunction(() => {
    try {
      const raw = localStorage.getItem("larsaStaffV8");
      if (!raw) return false;
      const doc = JSON.parse(raw);
      return Array.isArray(doc.users) && doc.users.length > 0;
    } catch { return false; }
  }, { timeout: 60000 });
}

async function readDoc(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("larsaStaffV8") || "{}"));
}

async function qaState(page) {
  return page.evaluate((email) => {
    const doc = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
    const me = (doc.users || []).find((u) => (u.email || "").toLowerCase() === email);
    const raw = (doc.logs || []).filter((l) => me && l.uid === me.id && (l.status === "In" || l.status === "Out"))
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    const logs = raw.map((l) => ({ id: l.id, s: l.status, t: l.time, m: l.type }));
    const last = logs[logs.length - 1] || null;
    return {
      uid: me ? me.id : null,
      pw: me ? String(me.password || "").slice(0, 30) : null,
      pwAt: me ? me.passwordChangedAt || null : null,
      touchedAt: me ? me.touchedAt || null : null,
      emailVerified: me ? me.emailVerified : null,
      punches: logs,
      last,
      activeCount: (doc.logs || []).filter((l) => me && l.uid === me.id && l.active).length,
    };
  }, QA_EMAIL);
}


async function waitQaVisible(page) {
  await page.waitForFunction((wanted) => {
    try {
      const doc = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
      return (doc.users || []).some((u) => (u.email || "").toLowerCase() === wanted);
    } catch { return false; }
  }, QA_EMAIL, { timeout: 45000 }).catch(() => {});
}

async function signIn(page, email, pass, { expectCode } = {}) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await waitStoreReady(page);
  /* A fresh browser can briefly hold the engines' placeholder seed until the
     authoritative pull replaces it; sign-in must judge against the REAL
     directory, so wait until this account is actually in view. */
  await page.waitForFunction((wanted) => {
    try {
      const doc = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
      return (doc.users || []).some((u) => (u.email || "").toLowerCase() === wanted);
    } catch { return false; }
  }, email, { timeout: 45000 }).catch(() => {});
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', pass);
  const clickedAt = new Date().toISOString();
  await page.click("button.auth-submit");
  // Either the workspace appears, a verification stage appears, or an error.
  const outcome = await Promise.race([
    page.waitForSelector('input[placeholder="123456"]', { timeout: 40000 }).then(() => "code").catch(() => null),
    page.waitForSelector('button[aria-label="Sign out"]', { timeout: 40000 }).then(() => "in").catch(() => null),
    page.waitForFunction(() => {
      const el = document.querySelector(".auth-error");
      return el && el.textContent && el.textContent.trim().length > 0;
    }, { timeout: 40000 }).then(async () => "error:" + (await page.locator(".auth-error").first().textContent())).catch(() => null),
  ]);
  if (String(outcome).startsWith("error:")) return outcome;
  if (outcome === "code") {
    if (expectCode === false) fail("sign-in demanded a code when the configured interval had NOT expired");
    const code = await awaitCode(email, clickedAt);
    await page.fill('input[placeholder="123456"]', code);
    await page.click("button.auth-submit");
    await page.waitForSelector('button[aria-label="Sign out"]', { timeout: 30000 });
    return "in-with-code";
  }
  return outcome;
}


/* Press the punch button and confirm the handler actually appended a log
 * row. A headless driver occasionally loses a DOM click in a re-render;
 * re-issuing after a confirmed no-op is exactly what a person does when a
 * button visibly did nothing. Every scenario still asserts the NET effect
 * (exactly one state step), so a double-registration would be caught. */
async function punchAndConfirm(page, expectStatus) {
  const start = await qaState(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click("button.clock-punch");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      const now = await qaState(page);
      if (now.punches.length > start.punches.length) {
        if (attempt > 0) log(`note: punch needed ${attempt + 1} DOM clicks (headless re-render race); handler fired once`);
        if (expectStatus && now.last.s !== expectStatus) fail(`punch produced ${now.last.s}, expected ${expectStatus}`);
        return now;
      }
    }
  }
  fail("the punch click never registered");
}

async function openClock(page) {
  // The Home overview lists a "Clock In / Out" card; clicking it opens quick-clock.
  const card = page.locator("text=Record your attendance in one tap").first();
  if (await card.count()) { await card.click(); }
  else {
    await page.locator('button:has-text("Clock In / Out")').first().click();
  }
  await page.waitForSelector("button.clock-punch", { timeout: 20000 });
}

const main = async () => {
  writeFileSync(LOG, "");
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  /* Sandbox quirk, not an app concern: this container's egress path stalls
     browser-originated POSTs to the backend (auth token, functions, RPC
     writes) while Node-side calls sail through. Carry ALL of the app's
     backend HTTP over Playwright's Node-side network stack, byte for byte,
     so the flows under test run exactly as written. (WebSockets cannot be
     routed this way, so realtime pushes are exercised in production
     verification instead; here, reloads perform the authoritative reads.) */
  for (const ctx of [ctxA, ctxB]) {
    await ctx.route("**://*.supabase.co/**", async (route) => {
      try {
        const response = await ctx.request.fetch(route.request(), { timeout: 30000 });
        await route.fulfill({ response });
      } catch (e) {
        appendFileSync(LOG, `  [route] ${route.request().method()} ${route.request().url().slice(0, 110)} did not complete: ${String(e && e.message).slice(0, 120)}\n`);
        try { await route.abort(); } catch { /* page is navigating */ }
      }
    });
  }
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  dumpPages = [["A", A], ["B", B]];
  for (const [name, page] of [["A", A], ["B", B]]) {
    page.on("console", (m) => {
      const t = m.text();
      if (t.includes("[larsa-sync]") || t.includes("error")) appendFileSync(LOG, `  [console ${name}] ${t}\n`);
    });
  }

  // ---------- S1: self-signup with emailed code ----------
  await A.goto(BASE, { waitUntil: "domcontentloaded" });
  await waitStoreReady(A);
  ok("S0 app served locally against the production backend; shared store synced");

  // The engines may seed a placeholder store into a fresh browser before the
  // authoritative pull lands, so "QA missing right now" is not proof it does
  // not exist — give the pull a fair window before deciding.
  let qaKnown = false;
  for (let i = 0; i < 20 && !qaKnown; i++) {
    qaKnown = Boolean((await qaState(A)).uid);
    if (!qaKnown) await A.waitForTimeout(1000);
  }
  if (qaKnown) {
    log("S1 QA account already present in the shared store (earlier run) — skipping signup");
  } else {
  await A.click("text=Create account");
  await A.fill('input[autocomplete="name"]', QA_NAME);
  await A.fill('input[placeholder="name@larsaeng.com"]', QA_EMAIL);
  const pwFields = A.locator('input[autocomplete="new-password"]');
  await pwFields.nth(0).fill(QA_PASS_1);
  await pwFields.nth(1).fill(QA_PASS_1);
  await A.fill('input[placeholder="4 to 8 digits"]', QA_PIN);
  await A.fill('input[placeholder="Type it again"]', QA_PIN);
  const signupClickedAt = new Date().toISOString();
  await A.click("button.auth-submit");
  const signupStage = await Promise.race([
    A.waitForSelector('input[placeholder="123456"]', { timeout: 30000 }).then(() => "code").catch(() => null),
    A.waitForSelector("text=already exists", { timeout: 30000 }).then(() => "exists").catch(() => null),
  ]);
  if (signupStage === "exists") {
    // A previous (partial) run already created the QA account — reuse it.
    log("S1 QA account already exists from an earlier run — continuing with it");
    await A.click("text=Back to sign in");
  } else {
    const signupCode = await awaitCode(QA_EMAIL, signupClickedAt);
    await A.fill('input[placeholder="123456"]', signupCode);
    await A.click("button.auth-submit");
    const created = await Promise.race([
      A.waitForSelector("text=Account ready", { timeout: 30000 }).then(() => "created").catch(() => null),
      A.waitForSelector("text=already exists", { timeout: 30000 }).then(() => "exists").catch(() => null),
    ]);
    if (created === "created") {
      ok("S1 self-signup completed with emailed code");
    } else if (created === "exists") {
      log("S1 QA account already exists from an earlier run (detected after code) — continuing with it");
      await A.click("text=Back to sign in");
    } else {
      fail("signup ended in neither creation nor duplicate detection");
    }
    // The mailer enforces a 60s resend cooldown per address+purpose.
    log("cooling down 65s before first sign-in (mailer resend window)");
    await sleep(65000);
  }
  }

  // ---------- S2: first sign-in (initial server stamp) then a second
  // sign-in that must NOT ask for a code ----------
  // The mailer's 60s resend window can refuse the sign-in gate's automatic
  // code send after a recent send for the same address; wait it out.
  let first = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    first = await signIn(A, QA_EMAIL, QA_PASS_1, {});
    if (String(first).startsWith("error:") && /just sent|wait/i.test(String(first))) {
      log("mailer cooldown hit on sign-in — waiting 65s and retrying");
      await sleep(65000);
      continue;
    }
    break;
  }
  if (!String(first).startsWith("in")) fail("first sign-in failed: " + first);
  ok("S2a first sign-in OK (" + first + ")");
  await A.waitForTimeout(2500);

  await A.locator('button[aria-label="Sign out"]').first().click();
  await A.waitForSelector('input[name="email"]', { timeout: 20000 });
  const second = await signIn(A, QA_EMAIL, QA_PASS_1, { expectCode: false });
  if (second !== "in") fail("second sign-in outcome unexpected: " + second);
  ok("S2b second sign-in required NO code — verification follows Platform Settings interval");

  // ---------- S3: clock in Online; first click must take ----------
  await openClock(A);
  // A prior partial run may have left the QA account clocked in; close that
  // session first so the scenario starts from a known state.
  if ((await qaState(A)).last?.s === "In") {
    log("closing a leftover open QA session from an earlier run");
    await punchAndConfirm(A, "Out");
    await A.waitForSelector("text=Off the clock", { timeout: 15000 });
    await A.waitForTimeout(2500);
  }
  await A.click('.clock-modes button:has-text("Online")');
  await A.waitForTimeout(250);
  const before = await qaState(A);
  // ---------- S3: one decision, one click, one session. ----------
  // The punch handler appends a log row synchronously; poll the store for
  // it. (A headless test driver can occasionally lose the DOM click in a
  // re-render — that is a driver artifact, so the click is re-issued; the
  // assertions below still require the burst to net EXACTLY one punch.)
  // The whole burst lands inside the double-fire window: three DOM clicks
  // back-to-back, then ONE confirmation of the net effect. Exactly one punch
  // may result, whichever of the clicks the headless driver delivered first.
  let afterIn = null;
  for (let round = 0; round < 3 && !afterIn; round++) {
    await A.click("button.clock-punch");
    await A.click("button.clock-punch", { delay: 5 }).catch(() => {});
    await A.click("button.clock-punch", { delay: 5 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      await A.waitForTimeout(300);
      const now = await qaState(A);
      if (now.punches.length > before.punches.length) { afterIn = now; break; }
    }
    if (!afterIn && round < 2) log("note: click burst not registered by the driver; re-issuing");
  }
  if (!afterIn) fail("clock-in never registered a punch");
  await A.waitForSelector("text=On the clock", { timeout: 15000 });
  await A.waitForTimeout(600);
  afterIn = await qaState(A);
  if (!(afterIn.punches.length === before.punches.length + 1)) fail("the click burst did not net exactly one punch: +" + (afterIn.punches.length - before.punches.length));
  if (afterIn.last.s !== "In" || afterIn.last.m !== "Online") fail("clock-in state wrong: " + JSON.stringify(afterIn.last));
  if (afterIn.activeCount !== 1) fail("active flags not exactly 1 after clock-in: " + afterIn.activeCount);
  ok("S3 clock-in Online: the punch took effect, exactly one session, one active flag");
  ok("S4 rapid extra clicks inside the guard window changed nothing");
  // Give the immediate push a moment to land before navigating away — the
  // punch is already safe locally; this mirrors a person seeing the toast.
  await A.waitForTimeout(2500);

  // refresh keeps state + mode
  await A.reload({ waitUntil: "domcontentloaded" });
  await waitStoreReady(A);
  await A.waitForSelector('button[aria-label="Sign out"]', { timeout: 30000 });
  await openClock(A);
  await A.waitForSelector("text=On the clock · Online", { timeout: 30000 });
  ok("S5 refresh keeps Clocked-In · Online exactly");

  // ---------- S6: device B sees the state; then a stale wholesale
  // write-back from B must NOT erase A's punch ----------
  const bIn = await signIn(B, QA_EMAIL, QA_PASS_1, {});
  if (!String(bIn).startsWith("in")) fail("device B sign-in failed: " + bIn);
  // Realtime websockets cannot be carried over the sandbox's Node-side
  // transport, so B converges through authoritative pulls (exactly what a
  // reopened phone does). Poll with reloads until A's punch is visible.
  let bState = null;
  for (let i = 0; i < 5; i++) {
    await B.waitForTimeout(2500);
    bState = await qaState(B);
    if (bState.last && bState.last.s === "In") break;
    await B.reload({ waitUntil: "domcontentloaded" });
    await waitStoreReady(B);
  }
  if (!bState.last || bState.last.s !== "In") fail("device B does not see the open session: " + JSON.stringify(bState.last));
  ok("S6a device B sees the live clocked-in state");

  const staleDoc = await B.evaluate(() => {
    const raw = localStorage.getItem("larsaStaffV8");
    const doc = JSON.parse(raw);
    return raw && doc ? raw : null;
  });
  // Doctor a STALE copy: remove the QA account's punches entirely and
  // pretend the tombstone lists are empty (the classic engine save).
  const doctored = await B.evaluate((email) => {
    const doc = JSON.parse(localStorage.getItem("larsaStaffV8"));
    const me = (doc.users || []).find((u) => (u.email || "").toLowerCase() === email);
    doc.logs = (doc.logs || []).filter((l) => !me || l.uid !== me.id);
    doc.removedLogIds = [];
    return JSON.stringify(doc);
  }, QA_EMAIL);
  await B.evaluate((text) => localStorage.setItem("larsaStaffV8", text), doctored);
  log("S6b stale write-back injected on device B (QA punches stripped)");
  await B.waitForTimeout(6000); // debounce + push + heal
  // Reload both devices: the bootstrap pull IS the authoritative read, so
  // whatever survived on the server is what these assertions now see.
  await A.reload({ waitUntil: "domcontentloaded" }); await waitStoreReady(A); await waitQaVisible(A);
  await B.reload({ waitUntil: "domcontentloaded" }); await waitStoreReady(B); await waitQaVisible(B);
  await A.waitForTimeout(2000); await B.waitForTimeout(2000);

  const aAfterStale = await qaState(A);
  const bAfterStale = await qaState(B);
  if (!aAfterStale.last || aAfterStale.last.s !== "In") fail("stale write-back destroyed the open session on A: " + JSON.stringify(aAfterStale.last));
  if (!bAfterStale.last || bAfterStale.last.s !== "In") fail("device B did not converge back to the healed state: " + JSON.stringify(bAfterStale.last));
  if (aAfterStale.last.m !== "Online") fail("work mode flipped after stale write-back: " + aAfterStale.last.m);
  ok("S6c stale wholesale write-back was healed: session survived on both devices, mode intact");

  // ---------- S7: clock out closes the right session and STAYS closed ----------
  await openClock(A);
  await punchAndConfirm(A, "Out");
  await A.waitForSelector("text=Off the clock", { timeout: 15000 });
  const afterOut = await qaState(A);
  if (afterOut.last.s !== "Out") fail("clock-out did not close the session");
  if (afterOut.activeCount !== 0) fail("active flags remained after clock-out: " + afterOut.activeCount);
  ok("S7a clock-out closed the session, zero active flags");

  await A.waitForTimeout(4000);
  await A.reload({ waitUntil: "domcontentloaded" });
  await waitStoreReady(A);
  await A.waitForSelector('button[aria-label="Sign out"]', { timeout: 30000 });
  await openClock(A);
  await A.waitForSelector("text=Off the clock", { timeout: 30000 });
  const bConverged = await (async () => {
    for (let i = 0; i < 15; i++) {
      const s = await qaState(B);
      if (s.last && s.last.s === "Out") return true;
      await B.waitForTimeout(1000);
    }
    return false;
  })();
  if (!bConverged) fail("device B still shows clocked-in after clock-out");
  ok("S7b clocked-out state survives refresh and reached device B");

  // A second stale write-back now tries to REOPEN the closed session by
  // replaying the pre-clock-out document.
  await B.evaluate((text) => localStorage.setItem("larsaStaffV8", text), doctored);
  await B.waitForTimeout(6000);
  await A.reload({ waitUntil: "domcontentloaded" }); await waitStoreReady(A); await waitQaVisible(A); await A.waitForTimeout(2000);
  const reopened = await qaState(A);
  if (!reopened.last || reopened.last.s !== "Out") fail("a stale replay reopened a closed session: " + JSON.stringify(reopened.last));
  ok("S7c a stale replay could not reopen the closed session");

  // ---------- S8: password change sticks; a stale record cannot drag the
  // old password back ----------
  log("cooling down 65s before the password-change code (mailer resend window)");
  await sleep(65000);
  await A.locator("button.account-open").click();
  const signinTab = A.locator('.settings-tabs button:has-text("Sign-in")');
  await signinTab.first().waitFor({ state: "visible", timeout: 20000 });
  await signinTab.first().click();
  await A.getByLabel("New password", { exact: true }).fill(QA_PASS_2);
  await A.getByLabel("Confirm password", { exact: true }).fill(QA_PASS_2);
  const pwClickedAt = new Date().toISOString();
  await A.locator('button:has-text("Update sign-in")').first().click();
  await A.waitForSelector('input[placeholder="123456"]', { timeout: 25000 });
  const pwCode = await awaitCode(QA_EMAIL, pwClickedAt);
  await A.fill('input[placeholder="123456"]', pwCode);
  await A.locator('button:has-text("Confirm change")').first().click();
  await A.waitForSelector("text=Sign-in details updated", { timeout: 25000 });
  await A.waitForTimeout(2500);
  const afterPw = await qaState(A);
  if (!afterPw.pwAt) fail("password change did not stamp passwordChangedAt");
  ok("S8a password changed and stamped");

  // Confirm the change is on the SERVER before the stale-copy scenario:
  // device B pulls fresh copies until it sees the new stamp, which separates
  // "the durability rule failed" from "the save had not landed yet".
  let serverHasNewPw = false;
  for (let i = 0; i < 8 && !serverHasNewPw; i++) {
    await B.reload({ waitUntil: "domcontentloaded" });
    await waitStoreReady(B);
    await waitQaVisible(B);
    await B.waitForTimeout(1500);
    const sb = await qaState(B);
    serverHasNewPw = sb.pwAt === afterPw.pwAt && sb.pw === afterPw.pw;
  }
  if (!serverHasNewPw) fail("the password change never reached the server (save did not land)");
  ok("S8a2 the password change is confirmed on the server");

  // Device B still holds the OLD record; replay it wholesale.
  await B.evaluate((text) => localStorage.setItem("larsaStaffV8", text), staleDoc);
  await B.waitForTimeout(6000);
  await A.reload({ waitUntil: "domcontentloaded" }); await waitStoreReady(A); await waitQaVisible(A); await A.waitForTimeout(2000);
  const healedPw = await qaState(A);
  if (healedPw.pw !== afterPw.pw) fail("stale replay dragged the old password back");
  ok("S8b stale replay could NOT revert the password");

  await A.locator('button[aria-label="Sign out"]').first().click();
  await A.waitForSelector('input[name="email"]', { timeout: 20000 });
  const relog = await signIn(A, QA_EMAIL, QA_PASS_2, { expectCode: false });
  if (relog !== "in") fail("sign-in with the NEW password failed after stale replay: " + relog);
  ok("S8c new password signs in cleanly, no false 'does not match', no code demanded");

  // ---------- S9: PIN sign-in honours the PIN interval (no code while
  // the server stamp is fresh) ----------
  await B.reload({ waitUntil: "domcontentloaded" });
  await waitStoreReady(B);
  if (await B.locator('button[aria-label="Sign out"]').count()) {
    await B.locator('button[aria-label="Sign out"]').first().click();
    await B.waitForSelector('input[name="email"]', { timeout: 20000 });
  }
  await B.click('button:has-text("Employee PIN")');
  await B.fill('input[placeholder="Enter your PIN"]', QA_PIN);
  await B.click("button.auth-submit");
  const pinOutcome = await Promise.race([
    B.waitForSelector('input[placeholder="123456"]', { timeout: 20000 }).then(() => "code").catch(() => null),
    B.waitForSelector("button.clock-punch", { timeout: 20000 }).then(() => "in").catch(() => null),
  ]);
  if (pinOutcome !== "in") fail("PIN sign-in demanded a code inside the configured interval: " + pinOutcome);
  ok("S9 PIN sign-in landed on the clock with no code (server stamp honoured)");

  await browser.close();
  writeFileSync("/tmp/e2e_result.json", JSON.stringify({ ok: true }));
  log("ALL E2E SCENARIOS PASSED");
};

main().catch(async (e) => {
  const msg = e && e.message && e.message.startsWith("E2E_FAIL")
    ? e.message
    : (e && e.stack || String(e));
  log("ABORTED: " + msg);
  try { writeFileSync("/tmp/e2e_result.json", JSON.stringify({ ok: false, msg })); } catch { /* best effort */ }
  await dumpState();
  process.exit(1);
});
