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
test("Classic is the absence of a theme attribute, so it cannot drift", () => {
  // Only "executive" writes data-theme. A person who never opens the selector
  // gets byte-identical CSS to before, rather than a Classic theme that has to
  // be kept manually in sync with the original.
  assert.match(page, /\{\.\.\.\(appearance === "executive" \? \{ "data-theme": "executive" \} : \{\}\)\}/);
  assert.match(page, /useState<"classic" \| "executive">\("classic"\)/);
  assert.doesNotMatch(css, /\[data-theme="classic"\]/);
});

test("theme and light/dark are independent controls", () => {
  // Two separate pieces of state and two separate controls: Executive at night
  // has to be reachable.
  assert.match(page, /const \[dark, setDark\] = useState\(false\);/);
  assert.match(page, /const \[appearance, setAppearance\] = useState/);
  assert.match(css, /\.unified-app\[data-theme="executive"\]\.dark \{/);
});

test("theme choice does not touch layout", () => {
  // Nothing in the Executive block sets a grid or a span; a theme that
  // rearranged cards would break the promise that the two are separate.
  const exec = css.slice(css.indexOf('--- LARSA Executive'));
  assert.doesNotMatch(exec, /grid-template-columns|grid-column|grid-row|grid-auto-flow/);
});

test("LARSA Executive flattens the six work-area accents to one grey", () => {
  const exec = css.slice(css.indexOf('--- LARSA Executive'));
  for (const accent of ["green", "blue", "amber", "violet", "rose", "slate"]) {
    assert.ok(exec.includes(`.module-bubble.${accent}`), `${accent} accent must be neutralised`);
  }
  // One shared pair of tokens rather than six different ones.
  assert.match(exec, /--bubble-soft: #eceef1;\s*\n\s*--bubble-ink: #2f3236;/);
});

test("it removes the colourful card wash without removing the card", () => {
  const exec = css.slice(css.indexOf('--- LARSA Executive'));
  // A quiet vertical gradient between neutral surfaces, a thin border doing
  // the work the colour used to do.
  assert.match(exec, /background: linear-gradient\(180deg, var\(--exec-surface\) 0%, var\(--exec-canvas\) 100%\);/);
  assert.match(exec, /border: 1px solid var\(--exec-line\);/);
  // The decorations are quietened, not deleted — removing them would change
  // the card's shape language.
  assert.match(exec, /\.module-bubble::after,[\s\S]*?\.module-blob \{\s*\n\s*background: currentColor;\s*\n\s*opacity: \.035;/);
});

test("the palette really is monochrome", () => {
  const exec = css.slice(css.indexOf('--- LARSA Executive'));
  const hexes = [...exec.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]);
  assert.ok(hexes.length >= 8, `expected a full palette, found ${hexes.length}`);

  /* Saturation, not raw channel spread, is what decides whether something
     reads as a colour, and very dark tones are unforgiving: a few points of
     channel difference is a large RELATIVE saturation. This check caught a
     genuinely cool #4a5060 at 23%, which was fixed in the palette rather than
     waved through here. The accents this theme replaces run far higher, so a
     real hue slipping in fails loudly — proven immediately below. */
  hexes.forEach((hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    assert.ok(saturation <= 0.18,
      `#${hex} is a colour, not a grey (saturation ${(saturation * 100).toFixed(0)}%)`);
  });

  // And prove the guard actually bites, using the accents this theme replaces.
  ["159b56", "2563eb", "9a3412"].forEach((accent) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    assert.ok((max - min) / max > 0.18, `#${accent} should have been rejected by this check`);
  });
});

test("colour that carries meaning survives the theme", () => {
  const exec = css.slice(css.indexOf('--- LARSA Executive'));
  // Approved / returned / overdue / error must keep their hue: greying these
  // out would remove information, not decoration.
  ["record-status", "auth-error", "notify-hint.bad", "notify-hint.good", "status-badge.off"]
    .forEach((cls) => assert.ok(exec.includes(cls), `${cls} must keep its status colour`));
  assert.match(exec, /Status colour is information, not decoration/);
});

test("the theme is offered to the person, and remembered", () => {
  assert.match(page, /<option value="classic">Classic<\/option>/);
  assert.match(page, /<option value="executive">LARSA Executive<\/option>/);
  assert.match(page, /aria-label="Theme"/);
  assert.match(page, /localStorage\.setItem\("larsa-control-appearance", appearance\)/);
  assert.match(page, /if \(look === "executive" \|\| look === "classic"\) setAppearance\(look\);/);
});

test("only known theme values are ever accepted from storage", () => {
  // A hand-edited preference cannot put an arbitrary string into the DOM
  // attribute — anything but the two known values leaves Classic in place.
  assert.match(page, /if \(look === "executive" \|\| look === "classic"\) setAppearance\(look\);/);
  assert.doesNotMatch(page, /setAppearance\(localStorage\.getItem/);
});
