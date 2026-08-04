/* Larsa Control — the smart card grid, measured in a real browser.
 *
 * The unit tests prove the arithmetic. This proves the arithmetic reaches the
 * screen: it signs in as accounts with different permissions, so the grid gets
 * a different number of cards each time, and measures where the cards actually
 * land. A gap is a geometric fact — cards whose bottom row is narrower than
 * the row above it — so it is checked geometrically rather than by eye.
 *
 *   node tests/smart-cards-e2e.smoke.mjs        # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";

/* Each role sees a different set of Home work-area cards, which is exactly the
   condition the old fixed grid could not cope with. */
const ROLES = [
  { access: "Engineer",    role: "Engineer" },
  { access: "Accountant",  role: "Accountant" },
  { access: "Manager",     role: "Manager" },
  { access: "Super Admin", role: "Super Admin" },
];

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

for (const spec of ROLES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const user = {
    id: `u-${spec.access.replace(/\s+/g, "-").toLowerCase()}`,
    name: `${spec.access} Test`, email: `qa-${Date.now()}@larsaeng.com`,
    role: spec.role, access: spec.access, enabled: true, active: true,
  };
  await page.addInitScript((seed) => {
    localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [seed] }));
    sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: seed, method: "email" }));
  }, user);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(2600);

  const geom = await page.evaluate(() => {
    const grid = document.querySelector(".native.active .module-grid.smart-grid");
    if (!grid) return null;
    const cells = [...grid.querySelectorAll(":scope > .smart-cell")];
    const gridBox = grid.getBoundingClientRect();
    // Group cells into rows by their top edge.
    const rows = new Map();
    cells.forEach((cell) => {
      const box = cell.getBoundingClientRect();
      const key = Math.round(box.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({ left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) });
    });
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) =>
      list.sort((a, b) => a.left - b.left));
    return {
      count: cells.length,
      gridWidth: Math.round(gridBox.width),
      gridLeft: Math.round(gridBox.left),
      gridRight: Math.round(gridBox.right),
      rows: ordered.map((row) => ({
        cards: row.length,
        spanned: row[row.length - 1].right - row[0].left,
        widths: row.map((c) => c.width),
      })),
    };
  });

  const tag = `${spec.access} (${geom?.count ?? 0} cards)`;
  check(`${tag}: the smart grid rendered`, Boolean(geom) && geom.count > 0, JSON.stringify(geom));

  if (geom && geom.count) {
    // Every row must reach the full width of the grid. A short final row IS
    // the awkward gap this work exists to remove.
    const short = geom.rows.filter((row) => row.spanned < geom.gridWidth - 24);
    check(`${tag}: every row fills the grid — no trailing gap`,
      short.length === 0, JSON.stringify({ gridWidth: geom.gridWidth, rows: geom.rows }));

    // Cards within a row should be the same width; wildly uneven cards inside
    // one row is the "tiny card beside a huge one" the brief rules out.
    const uneven = geom.rows.filter((row) =>
      row.cards > 1 && (Math.max(...row.widths) - Math.min(...row.widths)) > 8);
    check(`${tag}: cards in a row share a width`, uneven.length === 0, JSON.stringify(uneven));

    // Nothing should be so narrow it cannot hold its own text.
    const tooNarrow = geom.rows.flatMap((row) => row.widths).filter((w) => w < 200);
    check(`${tag}: no card is squeezed below a readable width`,
      tooNarrow.length === 0, JSON.stringify(tooNarrow));
  }

  // Customize mode has to exist and must not navigate when engaged.
  const customise = page.locator(".native.active .smart-grid-customise");
  const hasButton = await customise.count();
  check(`${tag}: Customize Layout is offered`, hasButton === 1);
  if (hasButton) {
    const headingBefore = await page.locator(".native.active .overview-hero h2").textContent().catch(() => "");
    await customise.click();
    await page.waitForTimeout(500);
    const edit = await page.evaluate(() => {
      const grid = document.querySelector(".native.active .module-grid.smart-grid");
      return {
        editing: Boolean(grid && grid.classList.contains("is-editing")),
        tools: document.querySelectorAll(".native.active .smart-cell-tools").length,
        locked: document.querySelectorAll(".native.active .smart-cell-body.is-locked").length,
        actions: [...document.querySelectorAll(".native.active .smart-grid-actions button")]
          .map((b) => b.textContent.trim()),
      };
    });
    check(`${tag}: edit mode turns on with per-card tools`,
      edit.editing && edit.tools === geom.count, JSON.stringify(edit));
    check(`${tag}: cards are inert while rearranging`, edit.locked === geom.count);
    check(`${tag}: Auto Arrange, Reset, Cancel and Save are all offered`,
      ["Auto Arrange", "Reset to Default", "Cancel", "Save layout"].every((a) => edit.actions.includes(a)),
      JSON.stringify(edit.actions));

    // Clicking a card mid-edit must not leave the page.
    await page.locator(".native.active .smart-cell .module-bubble").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    const headingAfter = await page.locator(".native.active .overview-hero h2").textContent().catch(() => "");
    check(`${tag}: a card does not navigate while being rearranged`,
      headingAfter === headingBefore, `${headingBefore} -> ${headingAfter}`);

    await page.locator(".native.active .smart-grid-actions button", { hasText: "Cancel" }).click();
    await page.waitForTimeout(300);
  }

  // Mobile: one card per row, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const mobile = await page.evaluate(() => {
    const grid = document.querySelector(".native.active .module-grid.smart-grid");
    if (!grid) return null;
    const cells = [...grid.querySelectorAll(":scope > .smart-cell")];
    const tops = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)));
    const scroller = document.querySelector(".native.active .native-scroll");
    return {
      cards: cells.length, rows: tops.size,
      noSideways: scroller ? scroller.scrollWidth <= scroller.clientWidth + 2 : true,
    };
  });
  check(`${tag}: mobile puts one card per row`,
    mobile && mobile.rows === mobile.cards, JSON.stringify(mobile));
  check(`${tag}: mobile does not scroll sideways`, mobile?.noSideways, JSON.stringify(mobile));

  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length, passed: results.length - failed.length,
  failed: failed.map((f) => f.label),
}, null, 1));
process.exit(failed.length ? 1 : 0);
