/* Larsa Control — colour at night.
 *
 * The report, with a screenshot: "all colors only in night or dark mode must
 * be lighter because dark colors with black does not look awesome".
 *
 * It was right, and the cause was a single wrong instinct applied everywhere:
 * to make a colour work on a dark screen, darken it. A dark green disc on a
 * near-black card is not a green card, it is a smudge, and six smudges in a
 * grid read as dirt on the screen. Colour on black has to come from light —
 * a pale ink, and every fill made of that same ink at low alpha.
 *
 * These tests pin the rule rather than the exact hues, because the rule is
 * what keeps getting broken: in dark mode, no fill may be a dark opaque
 * colour, and no caption may still be wearing its light-mode ink.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const visual = await read("app/visual-pass.css");
const globals = await read("app/globals.css");

/* Perceived lightness, 0-255. Good enough to tell "light ink" from "dark
   smudge" without pulling in a colour library for six numbers. */
function luma(hex) {
  const v = hex.replace("#", "");
  const n = v.length === 3 ? v.split("").map((c) => c + c) : v.match(/../g);
  const [r, g, b] = n.map((p) => parseInt(p, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ------------------------------------------------------ the six work areas
const TONES = ["green", "violet", "rose", "amber", "blue", "slate"];

test("every work-area ink is light enough to read on near-black", () => {
  for (const tone of TONES) {
    const rule = visual.match(new RegExp(`\\.unified-app\\.dark \\.module-bubble\\.${tone}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `no night rule for ${tone}`);
    const ink = rule[0].match(/--bubble-ink:\s*(#[0-9a-f]{3,6})/i);
    assert.ok(ink, `${tone} has no ink`);
    assert.ok(luma(ink[1]) > 170, `${tone} ink ${ink[1]} is too dark for a black background`);
  }
});

test("the six sit at a similar lightness, so no card shouts over its neighbours", () => {
  const values = TONES.map((tone) => {
    const rule = visual.match(new RegExp(`\\.unified-app\\.dark \\.module-bubble\\.${tone}\\s*\\{[^}]*\\}`));
    return luma(rule[0].match(/--bubble-ink:\s*(#[0-9a-f]{3,6})/i)[1]);
  });
  assert.ok(Math.max(...values) - Math.min(...values) < 55, `spread ${Math.round(Math.max(...values) - Math.min(...values))} is too wide`);
});

test("and every fill is that same ink at low alpha, not a dark colour", () => {
  for (const tone of TONES) {
    const rule = visual.match(new RegExp(`\\.unified-app\\.dark \\.module-bubble\\.${tone}\\s*\\{[^}]*\\}`));
    assert.match(rule[0], /--bubble-soft:\s*rgba\(/, `${tone} orb fill is not translucent`);
    const blob = visual.match(new RegExp(`\\.unified-app\\.dark \\.module-bubble\\.${tone}\\s+\\.module-blob\\s*\\{[^}]*\\}`));
    assert.ok(blob, `${tone} has no corner wash`);
    assert.match(blob[0], /background:\s*rgba\(/, `${tone} corner wash is not translucent`);
  }
});

test("no opaque dark hex survives in the night card palette", () => {
  // The exact failure that produced the complaint: #14361f, #241f47, #3d1b28…
  const block = visual.match(/\.unified-app\.dark \.module-bubble\.green[\s\S]*?\.unified-app\.dark \.module-blob \{ opacity/);
  assert.ok(block);
  const darkHexes = (block[0].match(/#[0-9a-f]{6}/gi) || []).filter((hex) => luma(hex) < 120);
  assert.deepEqual(darkHexes, [], `these are still dark: ${darkHexes.join(", ")}`);
});

// ------------------------------------------------------- the overview tiles
test("the overview tiles are tinted, not near-black", () => {
  for (const state of ["due", "good"]) {
    const rule = globals.match(new RegExp(`\\.unified-app\\.dark \\.role-card\\.${state}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `no night rule for .role-card.${state}`);
    assert.match(rule[0], /background:\s*rgba\(/, `.role-card.${state} still has an opaque fill`);
  }
});

test("and their captions are no longer wearing the light-mode ink", () => {
  /* This was the worst of it: "Below the 5 person minimum" is the one line on
     the tile that has to be read at a glance, and it was #b4341f on black. */
  for (const [state, expected] of [["due", "#f28b82"], ["good", "#5fd39b"]]) {
    const rule = globals.match(new RegExp(`\\.unified-app\\.dark \\.role-card\\.${state} em\\s*\\{[^}]*\\}`));
    assert.ok(rule, `.role-card.${state} em has no night colour`);
    assert.match(rule[0], new RegExp(expected));
    assert.ok(luma(expected) > 140, `${expected} is too dark to read on black`);
  }
  // The same hardcoded red reached two other places.
  assert.match(globals, /\.unified-app\.dark \.reminder-row\.due em \{ color: #f28b82; \}/);
  assert.match(globals, /\.unified-app\.dark \.dev-card em\.due \{ color: #f28b82; \}/);
});

// --------------------------------------------------------- the shared tokens
test("the night status tokens are tints of their own inks", () => {
  const block = visual.match(/--info: #8ab4f8;[\s\S]*?--st-draft:[^\n]*\n/);
  assert.ok(block);
  for (const name of ["info", "success", "warning", "danger", "st-pending", "st-approved", "st-rejected", "st-draft"]) {
    assert.match(block[0], new RegExp(`--${name}-soft:\\s*rgba\\(`), `--${name}-soft is still an opaque colour`);
  }
});

test("none of this touches daylight", () => {
  // The light palette is untouched — the complaint was explicitly about night.
  assert.match(globals, /\.module-bubble\.green \{ --bubble-soft: #dcfce7; --bubble-ink: #166534; \}/);
  assert.match(globals, /\.role-card\.due \{ border-color: #f0c9c1; background: #fdf6f4; \}/);
  assert.match(globals, /\.role-card\.due em \{ color: #b4341f; \}/);
});
