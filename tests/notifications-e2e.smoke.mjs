/* Larsa Control — the notification centre, in a real browser.
 *
 * The contract tests read the source and the SQL tests run the functions; this
 * one drives the actual rendered UI, because "the panel opens" and "Escape
 * closes it" are claims about a browser, not about a string.
 *
 * It runs WITHOUT Supabase configured on purpose: that is the degraded path,
 * the one nobody exercises by hand, and the one where an empty bell would look
 * exactly like a working one.
 *
 *   node tests/notifications-e2e.smoke.mjs            # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";
const USER = {
  id: "u-sara", name: "Sara Ali", email: "sara@larsaeng.com",
  role: "Engineer", access: "Engineer", enabled: true, active: true,
};
const NOTES = {
  version: 1,
  items: [
    { id: "n1", event: "leave.decided", title: "Leave approved", body: "12 August is confirmed",
      at: new Date(Date.now() - 3 * 60000).toISOString(), toId: "u-sara", fromName: "Atheer Jumaah", read: false, itemId: "my-requests" },
    { id: "n2", event: "points.reviewed", title: "Points approved", body: "Week 31 signed off",
      at: new Date(Date.now() - 90 * 60000).toISOString(), toId: "u-sara", fromName: "Atheer Jumaah", read: true },
    { id: "n3", event: "admin.broadcast", title: "Office closed Friday", body: "Site visit day",
      at: new Date(Date.now() - 26 * 3600000).toISOString(), toId: "u-sara", fromName: "Administration", read: false },
  ],
};

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();

await page.addInitScript(({ user, notes }) => {
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [user] }));
  localStorage.setItem("larsaNotificationsV1", JSON.stringify(notes));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user, method: "email" }));
}, { user: USER, notes: NOTES });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(3000);

// ---------------------------------------------------------------- the bell
const bell = page.locator(".notif-button");
check("the bell is in the bar", await bell.count() === 1);
check("the unread count is on it", (await page.locator(".notif-count").textContent().catch(() => "")) === "2",
  await page.locator(".notif-count").textContent().catch(() => "(none)"));

// It must not navigate away — the whole point of the change.
const headingBefore = await page.locator(".page-heading h1").first().textContent().catch(() => "");
await bell.click();
await page.waitForTimeout(600);
const panel = page.locator(".bell-panel");
check("clicking the bell opens a panel", await panel.count() === 1);
check("and does not navigate away from the page you were on",
  (await page.locator(".page-heading h1").first().textContent().catch(() => "")) === headingBefore);

const shape = await page.evaluate(() => {
  const p = document.querySelector(".bell-panel");
  if (!p) return null;
  const box = p.getBoundingClientRect();
  return {
    filters: [...p.querySelectorAll(".bell-filters button")].map((b) => b.textContent.trim()),
    rows: [...p.querySelectorAll(".bell-row")].map((r) => ({
      title: r.querySelector("b")?.textContent,
      unread: r.classList.contains("unread"),
      ago: r.querySelector("em")?.textContent,
    })),
    hasSearch: Boolean(p.querySelector(".bell-search input")),
    foot: p.querySelector(".bell-foot")?.textContent?.trim(),
    onScreen: box.right <= window.innerWidth + 1 && box.left >= -1 && box.width > 260,
    dialog: p.getAttribute("role"),
  };
});
check("the panel is on screen and the right shape", shape?.onScreen, JSON.stringify(shape?.onScreen));
check("it announces itself as a dialog", shape?.dialog === "dialog");
check("it offers All, Unread and Archived", (shape?.filters || []).length === 3, JSON.stringify(shape?.filters));
check("it has a search box", shape?.hasSearch);
check("it lists the notifications on this device", (shape?.rows || []).length === 3, JSON.stringify(shape?.rows?.length));
check("unread rows are marked as such", (shape?.rows || []).filter((r) => r.unread).length === 2);
check("each row says how long ago", /ago|just now/.test(shape?.rows?.[0]?.ago || ""), shape?.rows?.[0]?.ago);
check("with no backend it says so plainly", /Showing this device only/.test(shape?.foot || ""), shape?.foot);

// ------------------------------------------------------------------ filter
await page.locator(".bell-filters button", { hasText: "Unread" }).click();
await page.waitForTimeout(400);
const unreadOnly = await page.locator(".bell-panel .bell-row").count();
check("the Unread filter narrows the list", unreadOnly === 2, String(unreadOnly));

await page.locator(".bell-filters button", { hasText: "All" }).click();
await page.waitForTimeout(300);

// ------------------------------------------------------------------ search
await page.locator(".bell-search input").fill("Friday");
await page.waitForTimeout(600);
const searched = await page.evaluate(() =>
  [...document.querySelectorAll(".bell-panel .bell-row b")].map((b) => b.textContent));
check("search narrows to the match", searched.length === 1 && /Friday/.test(searched[0] || ""), JSON.stringify(searched));

await page.locator(".bell-search input").fill("zzzz-no-such-thing");
await page.waitForTimeout(600);
const empty = await page.locator(".bell-panel .bell-empty").textContent().catch(() => "");
check("a search with no match says so rather than looking broken", /Nothing matches/.test(empty), empty);
await page.locator(".bell-search input").fill("");
await page.waitForTimeout(500);

// ------------------------------------------------------------- keyboard/away
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Escape closes the panel", await page.locator(".bell-panel").count() === 0);

await bell.click();
await page.waitForTimeout(400);
await page.mouse.click(700, 700);
await page.waitForTimeout(400);
check("a click outside closes it", await page.locator(".bell-panel").count() === 0);

// ------------------------------------------------------------------ deep link
await bell.click();
await page.waitForTimeout(500);
await page.locator(".bell-panel .bell-open").first().click();
await page.waitForTimeout(900);
const afterOpen = await page.evaluate(() => ({
  panelGone: !document.querySelector(".bell-panel"),
  heading: document.querySelector(".native.active .page-heading h1")?.textContent
    || document.querySelector(".page-heading h1")?.textContent,
}));
check("opening a notification closes the panel", afterOpen.panelGone);
check("and lands on the screen it is about", /Leave|Request/i.test(afterOpen.heading || ""), afterOpen.heading);

// -------------------------------------------------------- settings: alerts
await page.evaluate(() => {
  const bellBtn = document.querySelector(".notif-button");
  if (bellBtn) bellBtn.click();
});
await page.waitForTimeout(400);
const settingsBtn = page.locator('.bell-head-actions button[aria-label="Notification settings"]');
check("the panel links to the settings", await settingsBtn.count() === 1);
await settingsBtn.click();
await page.waitForTimeout(1000);

await page.locator('.settings-tabs button', { hasText: "Notifications" }).click();
await page.waitForTimeout(700);
const settings = await page.evaluate(() => {
  const root = document.querySelector(".native.active .notify-settings") || document.querySelector(".notify-settings");
  if (!root) return null;
  return {
    promise: root.querySelector(".notify-promise")?.textContent?.replace(/\s+/g, " ").trim(),
    heading: root.querySelector("h3")?.textContent,
    states: [...root.querySelectorAll(".notify-state b")].map((b) => b.textContent),
    // With no backend there are no categories to show, and the panel should
    // say why rather than render an empty list.
    hasInbox: Boolean(root.querySelector(".inbox-list")),
  };
});
check("the Notifications tab renders", Boolean(settings), JSON.stringify(settings));
check("it carries the promise about the bell, word for word",
  settings?.promise === "All Larsa Control notifications always remain available in the notification bell. These settings control only alerts outside the app.",
  settings?.promise);
check("its heading says these are alerts outside the app", settings?.heading === "Alerts outside the app", settings?.heading);
check("with no backend it explains that rather than failing silently",
  (settings?.states || []).some((s) => /Not configured/.test(s)), JSON.stringify(settings?.states));
check("the old Inbox tab is gone — the bell is the one place", !settings?.hasInbox);

const tabs = await page.evaluate(() =>
  [...document.querySelectorAll(".native.active .settings-tabs button")].map((b) => b.textContent.trim()));
check("Settings has three tabs, not four", tabs.length === 3, JSON.stringify(tabs));

// ------------------------------------------------------------------ mobile
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.locator(".notif-button").click();
await page.waitForTimeout(600);
const mobile = await page.evaluate(() => {
  const p = document.querySelector(".bell-panel");
  if (!p) return null;
  const box = p.getBoundingClientRect();
  const style = getComputedStyle(p);
  return {
    position: style.position,
    fitsWidth: box.left >= -1 && box.right <= window.innerWidth + 1,
    reachesBottom: Math.abs(box.bottom - window.innerHeight) < 2,
  };
});
check("on a phone it becomes a sheet rather than a cramped dropdown",
  mobile?.position === "fixed" && mobile?.reachesBottom, JSON.stringify(mobile));
check("and stays inside the screen", mobile?.fitsWidth, JSON.stringify(mobile));

// ------------------------------------------------------------- six cards
await page.setViewportSize({ width: 1400, height: 950 });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const cards = await page.evaluate(() => {
  const home = document.querySelector(".native.active .module-grid") || document.querySelector(".module-grid");
  return [...(home?.querySelectorAll(".module-bubble") || [])].map((c) => c.querySelector("b,h3")?.textContent?.trim());
});
/* Five, not six: this fixture signs in as an Engineer, and Administration is
   an admin card. What matters is that the cards are the same ones, in the same
   shape, as before the notification work — not that a count went up. */
check("the Home work-area cards are untouched",
  cards.length === 5 && cards.join("|") === "Time & Attendance|Performance|Engineering Management|HR & Skills|Accounting",
  JSON.stringify(cards));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length,
  passed: results.length - failed.length,
  failed: failed.map((f) => f.label),
}, null, 1));
process.exit(failed.length ? 1 : 0);
