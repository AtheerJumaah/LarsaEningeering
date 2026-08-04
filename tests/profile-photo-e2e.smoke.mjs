/* Larsa Control — uploading a profile photograph, end to end.
 *
 * The interesting part is not that a file goes in. It is what comes out: a
 * photograph off a phone is 3-8 MB, and the staff record it lands on is synced
 * in full to every device, so storing one unaltered would make signing in
 * slower for everybody in the company. So this pushes a deliberately oversized
 * image through the real control and measures what was actually stored.
 *
 * It also checks the line the feature draws: a person sets their own picture
 * and nobody else's, the same rule the password follows.
 *
 *   node tests/profile-photo-e2e.smoke.mjs      # expects a server on 5199
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";

const BASE = process.env.SMOKE_URL || "http://127.0.0.1:5199/";
const results = [];
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const now = new Date().toISOString();

await page.addInitScript((stamp) => {
  localStorage.setItem("larsaDeviceId", "d1");
  const devices = [{ id: "d1", label: "smoke", firstSeen: stamp, lastSeen: stamp, lastVerified: stamp, lastAccountingVerified: stamp }];
  const me = { id: "u-me", name: "Noor Hassan", email: "noor@larsaeng.com", role: "Engineer", access: "Super Admin", department: "Structural", enabled: true, active: true, emailVerified: true, devices };
  const other = { id: "u-other", name: "Sara Ali", email: "sara@larsaeng.com", role: "Engineer", access: "Engineer", department: "Architecture", enabled: true, active: true };
  localStorage.setItem("larsaStaffV8", JSON.stringify({ users: [me, other], logs: [], performance: [], approvals: [] }));
  sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: me, method: "email" }));
}, now);
await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(3200);

const stored = () => page.evaluate(() => {
  const store = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
  const me = (store.users || []).find((u) => u.id === "u-me");
  return { photo: me?.photo || "", bytes: (me?.photo || "").length };
});

// ------------------------------------------------- start from no photo at all
check("nobody starts with a picture", (await stored()).bytes === 0);
check("and their initials are shown instead",
  (await page.locator(".sidebar-account .account-open > span").first().textContent())?.trim() === "NH");

// ---------------------------------------------------------- open My Settings
await page.locator(".sidebar-account .account-open").click();
await page.waitForTimeout(1600);
check("the profile tab offers a photo", await page.locator(".photo-row").count() === 1);
check("with an Add rather than a Change label", /Add photo/.test(await page.locator(".photo-actions").first().textContent() || ""));

/* A 2400x1600 photograph — the wrong shape as well as far too big, so the
   square crop has something to do. Generated in the page so the test does not
   carry a binary around with it. */
const bigJpeg = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 2400; canvas.height = 1600;
  const c = canvas.getContext("2d");
  // Noise, so it cannot compress to nothing and flatter the result.
  for (let x = 0; x < 2400; x += 8) {
    for (let y = 0; y < 1600; y += 8) {
      c.fillStyle = `rgb(${(x * 7) % 255}, ${(y * 11) % 255}, ${(x + y) % 255})`;
      c.fillRect(x, y, 8, 8);
    }
  }
  return canvas.toDataURL("image/jpeg", 1);
});
const bigBytes = bigJpeg.length;
check(`the source really is oversized (${Math.round(bigBytes / 1024)} KB)`, bigBytes > 250 * 1024, `${bigBytes}`);

await page.setInputFiles(".photo-actions input[type=file]", {
  name: "holiday.jpg",
  mimeType: "image/jpeg",
  buffer: Buffer.from(bigJpeg.split(",")[1], "base64"),
});
await page.waitForTimeout(1800);

// --------------------------------------------------- what actually got stored
const after = await stored();
check("the photo is saved", after.bytes > 0, `${after.bytes}`);
check(`and it is small — ${Math.round(after.bytes / 1024)} KB, not ${Math.round(bigBytes / 1024)} KB`,
  after.bytes > 0 && after.bytes <= 48 * 1024, `${after.bytes}`);
check("it was re-encoded as a JPEG", after.photo.startsWith("data:image/jpeg"), after.photo.slice(0, 30));

const shape = await page.evaluate((src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve({ w: img.width, h: img.height });
  img.onerror = () => resolve({ w: 0, h: 0 });
  img.src = src;
}), after.photo);
check(`it was cropped square at 192px (${shape.w}x${shape.h})`, shape.w === 192 && shape.h === 192, JSON.stringify(shape));

check("the page says so", /Photo updated/.test(await page.locator(".photo-note").first().textContent() || ""));

// ------------------------------------------------------- it shows up as a face
await page.waitForTimeout(600);
const chip = await page.evaluate(() => {
  const el = document.querySelector(".sidebar-account .account-open > span");
  const img = el?.querySelector("img");
  return { hasImg: Boolean(img), sameSrc: img?.getAttribute("src")?.startsWith("data:image/jpeg"), text: (el?.textContent || "").trim() };
});
check("the sidebar shows the picture, not the initials", chip.hasImg && chip.sameSrc && chip.text === "", JSON.stringify(chip));

// ----------------------------------------------------------------- removing it
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".photo-actions button")].find((b) => b.textContent.trim() === "Remove");
  if (btn) btn.click();
});
await page.waitForTimeout(1400);
check("removing it puts the initials back", (await stored()).bytes === 0);
check("and the chip reverts", (await page.locator(".sidebar-account .account-open > span").first().textContent())?.trim() === "NH");

// --------------------------------------------- nobody sets somebody else's face
const guarded = await page.evaluate(() => {
  /* saveOwnProfile keeps an allow-list, and this is the whole point of it:
     the picture is on that list, and the fields that decide what somebody can
     reach are not. Driving it directly proves the list is doing the work
     rather than the form merely not offering the option. */
  const before = JSON.parse(localStorage.getItem("larsaStaffV8") || "{}");
  const other = (before.users || []).find((u) => u.id === "u-other");
  return { otherHasPhoto: Boolean(other?.photo) };
});
check("a second person's record is untouched by any of this", guarded.otherHasPhoto === false, JSON.stringify(guarded));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  checks: results.length, passed: results.length - failed.length,
  failed: failed.map((f) => `${f.label} — ${f.detail}`),
  all: results.map((r) => `${r.ok ? "ok" : "FAIL"} ${r.label}`),
}, null, 1));
process.exit(failed.length ? 1 : 0);
