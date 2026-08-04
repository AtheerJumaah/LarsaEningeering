/* Larsa Control — what colour the screen actually IS at night.
 *
 * This exists because of a mistake worth not repeating. The complaint was that
 * the overview tiles looked dark maroon and dark green on black. I replaced
 * their fills with the caption's own colour at 13% alpha, measured the DECLARED
 * colour, saw a pale red, and called it fixed.
 *
 * It was not fixed. Alpha does not make a colour light — it moves it towards
 * whatever is behind, and behind these is a near-black page. 13% of a pale red
 * over rgb(11,13,17) composites to rgb(31,18,17): dark maroon, exactly what was
 * reported, twice. The stylesheet said one thing and the screen said another,
 * and I had only read the stylesheet.
 *
 * So this walks the real pages in dark mode, composites every background down
 * the ancestor chain the way the browser does, and judges the resulting pixel.
 * The static test next door is still worth having — it is faster and it catches
 * an opaque dark hex the moment it is typed — but only this one can tell you
 * what somebody will actually see.
 *
 *   node tests/night-colour-e2e.smoke.mjs      # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";
/* Anything coloured must render at least this bright. The number is not
   arbitrary: the icon discs on the work-area cards sit at 66-72 and read as
   colours, the tiles as first shipped sat at 21 and read as dirt. 45 is below
   everything that currently passes and comfortably above everything that
   failed, so it catches a regression without pinning today's exact values. */
const FLOOR = 45;

const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
const now = new Date().toISOString();

await page.addInitScript((stamp) => {
  localStorage.setItem("larsaDeviceId", "d1");
  localStorage.setItem("larsa-control-theme", "dark");
  const devices = [{ id: "d1", label: "smoke", firstSeen: stamp, lastSeen: stamp, lastVerified: stamp, lastAccountingVerified: stamp }];
  const admin = { id: "u-admin", name: "Admin", email: "a@larsaeng.com", role: "Admin", access: "Super Admin", department: "Structural", enabled: true, active: true, emailVerified: true, devices };
  const sara = { id: "u2", name: "Sara Ali", email: "s@larsaeng.com", role: "Engineer", access: "Engineer", department: "Architecture", enabled: true, active: true };
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [admin, sara], logs: [], performance: [], approvals: [] }));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: admin, method: "email" }));
}, now);
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(3400);

check("dark mode is actually on", await page.evaluate(() => document.querySelector(".unified-app")?.classList.contains("dark")));

/* Composite an element's background over everything behind it, then classify.
   Neutral is exempt on purpose: panels, fields and the page itself are
   surfaces, not colours, and they are meant to be dark. They are told apart by
   hue, because at low brightness a saturation test flags every grey. */
const darkColours = () => page.evaluate(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    // color-mix resolves to color(srgb r g b) in some builds.
    const s = String(c).match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    return s ? [Math.round(+s[1] * 255), Math.round(+s[2] * 255), Math.round(+s[3] * 255), 1] : null;
  };
  const over = (fg, bg) => fg.slice(0, 3).map((c, i) => Math.round(c * fg[3] + bg[i] * (1 - fg[3])));
  const rendered = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c[3] === 0) continue;
      stack.push(c);
      if (c[3] >= 0.999) break;
    }
    let out = [11, 13, 17];                       // the page itself
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };
  const found = new Map();
  for (const el of document.querySelectorAll("*")) {
    if (!el.offsetParent) continue;
    const own = parse(getComputedStyle(el).backgroundColor);
    if (!own || own[3] === 0) continue;
    const [r, g, b] = rendered(el);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), chroma = mx - mn;
    if (chroma < 12) continue;                    // grey
    let hue = mx === r ? 60 * (((g - b) / chroma) % 6)
      : mx === g ? 60 * ((b - r) / chroma + 2)
        : 60 * ((r - g) / chroma + 4);
    if (hue < 0) hue += 360;
    if (hue > 195 && hue < 240) continue;         // the app's own blue-grey
    if (lum >= 45) continue;
    const key = `${el.className}|${r},${g},${b}`;
    if (!found.has(key)) found.set(key, `.${String(el.className).slice(0, 44)} renders rgb(${r}, ${g}, ${b}) lum=${Math.round(lum)}`);
  }
  return [...found.values()];
});

const openCard = async (label) => {
  await page.evaluate((l) => { const c = [...document.querySelectorAll(".module-bubble")].find((n) => (n.textContent || "").includes(l)); if (c) c.click(); }, label);
  await page.waitForTimeout(1700);
};
const openSide = async (label) => {
  await page.evaluate((l) => { const c = [...document.querySelectorAll(".sidebar .nav-list a, .sidebar .nav-list button")].find((n) => (n.textContent || "").includes(l)); if (c) c.click(); }, label);
  await page.waitForTimeout(1500);
};

const sweep = async (where, go) => {
  if (go) await go();
  const bad = await darkColours();
  check(`${where}: nothing coloured renders darker than ${FLOOR}`, bad.length === 0, bad.join(" | "));
};

await sweep("Home");
await sweep("Clock In / Out", () => openCard("Time & Attendance"));
await sweep("Leave & Requests", () => openSide("Leave & Requests"));
await sweep("Add My Points", async () => { await openSide("Home"); await openCard("Performance"); await openSide("Add My Points"); });
await sweep("HR & Skills", async () => { await openSide("Home"); await openCard("HR & Skills"); });
await sweep("Engineering", async () => { await openSide("Home"); await openCard("Engineering Management"); });

// ------------------------------------------ the two tiles that were reported
await openSide("Home");
await page.waitForTimeout(1200);
const tiles = await page.evaluate(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    const s = String(c).match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    return s ? [Math.round(+s[1] * 255), Math.round(+s[2] * 255), Math.round(+s[3] * 255)] : null;
  };
  const read = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const [r, g, b] = parse(getComputedStyle(el).backgroundColor) || [0, 0, 0];
    return { lum: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), rgb: `rgb(${r}, ${g}, ${b})` };
  };
  return { due: read(".role-card.due"), good: read(".role-card.good") };
});
check(`the "below minimum" tile is a light red, not a dark maroon (${tiles.due?.rgb})`, (tiles.due?.lum || 0) >= 60, JSON.stringify(tiles.due));
check(`the "all clear" tile is a light green, not a dark one (${tiles.good?.rgb})`, (tiles.good?.lum || 0) >= 60, JSON.stringify(tiles.good));

// ------------------------------------------------------------ and daylight
/* Toggled rather than reloaded: this file's init script re-seeds the theme on
   every navigation, so a reload would just put dark mode back and the check
   would pass by measuring the wrong thing. */
await page.locator('[aria-label="Toggle theme"]').first().click();
await page.waitForTimeout(1200);
check("the toggle actually reached daylight", await page.evaluate(() => !document.querySelector(".unified-app")?.classList.contains("dark")));
const day = await page.evaluate(() => {
  const el = document.querySelector(".role-card.due");
  return el ? { bg: getComputedStyle(el).backgroundColor, em: getComputedStyle(el.querySelector("em")).color } : null;
});
check("daylight is untouched", day?.bg === "rgb(253, 246, 244)" && day?.em === "rgb(180, 52, 31)", JSON.stringify(day));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length, passed: results.length - failed.length,
  failed: failed.map((f) => `${f.label} — ${f.detail}`),
  all: results.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.label}`),
}, null, 1));
process.exit(failed.length ? 1 : 0);
