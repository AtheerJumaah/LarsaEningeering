/* Larsa Control — the second theme, and the navigation gap it sat next to.
 *
 * Two separate claims are checked here. The first is that Engineering
 * Management is reachable from the sidebar rather than only from a Home card
 * — it had no nav channel of its own, so opening it left the sidebar showing
 * Home and the only way back was through Home again. The second is that a new
 * theme exists WITHOUT changing anything for people who do not pick it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const css = await read("app/visual-pass.css");

// ------------------------------------------------------------- navigation
test("Engineering Management has a nav channel of its own", () => {
  assert.match(page, /type NavChannel = "home" \| "time" \| "performance" \| "hr" \| "accounting" \| "engineering" \| "admin";/);
  assert.match(page, /if \(item\.id === "org-structure"\) return "engineering";/);
});

test("that channel resolves to a real sidebar group", () => {
  assert.match(page, /engineering: GROUPS\.find\(\(group\) => group\.label === "Engineering Management"\)!,/);
  // Built from the same GROUPS registry the rest of the nav reads, not a
  // second hardcoded list that could drift away from it.
  assert.match(page, /label: "Engineering Management",\s*items: \[/);
});

test("the Home card opens it on its own channel, not on Home", () => {
  assert.match(page, /\{ id: "org-structure", channel: "engineering" as const, title: "Engineering Management"/);
  // The old value is what produced the bug: navChannel stayed "home", so
  // contextGroup was null and the sidebar fell back to just Home.
  assert.doesNotMatch(page, /\{ id: "org-structure", channel: "home" as const/);
});

test("the sidebar still filters every group by access", () => {
  // The new group goes through the same permission filter as every other one,
  // so a channel of its own cannot become a way to show an unauthorised module.
  assert.match(page, /items: group\.items\.filter\(\(item\) => canOpenInSession\(sessionUser, item, sessionMethod\)\)/);
  assert.match(page, /\.filter\(\(group\) => group\.items\.length\)/);
});

// ----------------------------------------------------------------- themes
test("the selector offers exactly two themes, named exactly", () => {
  assert.match(page, /<option value="classic">Classic<\/option>/);
  assert.match(page, /<option value="larsa">Larsa<\/option>/);
  // Only those two. A third option here is the failure this correction fixes.
  const picker = page.slice(page.indexOf('aria-label="Theme"'), page.indexOf("</select>", page.indexOf('aria-label="Theme"')));
  assert.equal((picker.match(/<option /g) || []).length, 2);
  // Names are capitalised as words, not shouted, and the old names are gone.
  assert.doesNotMatch(page, /LARSA Executive|Larsa Executive|>Executive<|Custom Theme/);
  assert.doesNotMatch(css, /LARSA Executive|data-theme="executive"/);
});

test("theme names use sentence capitalisation", () => {
  ["Classic", "Larsa"].forEach((name) => {
    assert.ok(page.includes(`>${name}<`), `${name} must be offered verbatim`);
    assert.equal(name[0], name[0].toUpperCase(), "first letter uppercase");
    assert.equal(name.slice(1), name.slice(1).toLowerCase(), "the rest lowercase");
  });
});

test("Classic is the absence of a theme attribute, so it cannot drift", () => {
  assert.match(page, /\{\.\.\.\(appearance === "larsa" \? \{ "data-theme": "larsa" \} : \{\}\)\}/);
  assert.match(page, /useState<"classic" \| "larsa">\("classic"\)/);
  assert.doesNotMatch(css, /\[data-theme="classic"\]/);
});

test("an older 'executive' preference migrates rather than reverting to Classic", () => {
  assert.match(page, /if \(look === "larsa" \|\| look === "executive"\) setAppearance\("larsa"\);/);
  assert.match(page, /else if \(look === "classic"\) setAppearance\("classic"\);/);
  // Anything unrecognised falls through to Classic, the do-nothing default.
  assert.doesNotMatch(page, /setAppearance\(localStorage\.getItem/);
});

test("theme and light/dark stay independent", () => {
  assert.match(page, /const \[dark, setDark\] = useState\(false\);/);
  assert.match(page, /const \[appearance, setAppearance\] = useState/);
  assert.match(css, /\.unified-app\[data-theme="larsa"\]\.dark \{/);
});

test("switching theme cannot disturb a saved card layout", () => {
  // Nothing in the theme sets a grid property, so order, spans and
  // cards-per-row are untouched by a theme change.
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  // `order:` needs a boundary — "border:" contains it, so every bordered
  // card would otherwise look like a CSS order property.
  assert.doesNotMatch(larsa, /grid-template-columns|grid-column:|grid-row:|grid-auto-flow|(?<![a-z-])order:/);
});

test("the decorative corner circles are removed, not merely faded", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  // display:none, not opacity — a 3% disc is still a disc.
  assert.match(larsa, /\.module-bubble::after,\s*\n\.unified-app\[data-theme="larsa"\] \.module-bubble \.module-blob \{ display: none; \}/);
  assert.doesNotMatch(larsa, /\.module-blob \{[^}]*opacity/);
  // And they stay gone at phone width.
  const mobile = larsa.slice(larsa.indexOf("@media (max-width: 720px)"));
  assert.match(mobile, /\.module-blob \{ display: none; \}/);
});

test("functional visuals survive the decoration cull", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  // The icon is restyled, never hidden — only the two decorative discs are.
  assert.match(larsa, /\.module-orb \{/);
  assert.doesNotMatch(larsa, /\.module-orb \{[^}]*display: none/);
  const hidden = [...larsa.matchAll(/([^\n{]+)\{\s*display: none;/g)].map((m) => m[1]);
  hidden.forEach((sel) => {
    assert.ok(/module-blob|module-bubble::after/.test(sel),
      `only the decorative discs may be hidden, not: ${sel.trim()}`);
  });
});

test("the theme is a real ramp, not one grey repeated", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  const ramp = [...larsa.matchAll(/--l-(\d+):\s*(#[0-9a-f]{6})/gi)];
  // Nine steps, light mode, and nine again for dark.
  assert.ok(ramp.length >= 18, `expected a full ramp in both modes, found ${ramp.length}`);
  const light = ramp.slice(0, 9).map((m) => m[2]);
  assert.equal(new Set(light).size, 9, "every step must be a distinct value");

  // Every step is a grey: saturation stays low, so the ramp carries depth
  // rather than hue.
  light.forEach((hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    assert.ok(max === 0 || (max - min) / max <= 0.18, `${hex} is a colour, not a grey`);
  });
});

test("it is not faded — headings and actions land near black", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  const val = (token) => (larsa.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i")) || [])[1];
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b) / 3;

  // Body/heading ink against the card surface must be a real contrast, not
  // grey-on-grey. --l-900 on --l-0 is the primary text pair.
  assert.ok(lum(val("--l-900")) < 40, "headings must be near-black");
  assert.ok(lum(val("--l-0")) > 240, "cards must be white");
  // Secondary text deliberately uses --l-600, not the muted --l-400: faint
  // secondary text is the usual way a grey theme becomes unreadable.
  assert.match(larsa, /--l-600, not --l-400/);
  assert.ok(lum(val("--l-600")) < 120, "secondary text must stay readable");
  // Primary buttons are black with white text, not another grey.
  assert.match(larsa, /button\.primary,[\s\S]*?background: var\(--l-900\) !important;/);
});

test("status colour survives, because it carries meaning", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  ["record-status.approved", "record-status.returned", "record-status.pending", "auth-error"]
    .forEach((cls) => assert.ok(larsa.includes(cls), `${cls} must keep its colour`));
  // Destructive actions stay red rather than matching the palette.
  assert.match(larsa, /\.delete-user-button,[\s\S]*?color: #b4341f;/);
  assert.match(larsa, /Turning "delete" grey to match a palette would cost/);
});

test("the sidebar follows the theme and stays permission-aware", () => {
  const larsa = css.slice(css.indexOf('--- Larsa theme'));
  assert.match(larsa, /\.unified-app\[data-theme="larsa"\] aside\.sidebar \{/);
  assert.match(larsa, /\.nav-item\.active,[\s\S]*?background: var\(--l-900\);/);
  // Styling the sidebar must not have touched who can see what.
  assert.match(page, /items: group\.items\.filter\(\(item\) => canOpenInSession\(sessionUser, item, sessionMethod\)\)/);
});

test("the theme is remembered per browser, under a value not a label", () => {
  assert.match(page, /localStorage\.setItem\("larsa-control-appearance", appearance\)/);
  // The stored value is the lowercase key, never the display label.
  assert.doesNotMatch(page, /setItem\("larsa-control-appearance", "Larsa"\)/);
});
