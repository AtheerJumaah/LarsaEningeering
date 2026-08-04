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

// ------------------------------------------------------------- the whole rule
/* The per-component tests above pin the places that were reported. This one
   pins the RULE, across both stylesheets, so the next coloured surface somebody
   adds at night cannot quietly be a dark one.
 *
 * Neutral is exempt and must be: panels, fields, the page itself and the rest
 * of the chrome are surfaces, not colours, and they are meant to be dark. The
 * test tells them apart by hue — the app's greys sit in a narrow blue band —
 * and by chroma, so a near-grey is never mistaken for a colour. */
function channels(value) {
  const hex = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  }
  const rgb = value.match(/rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)/);
  return rgb ? rgb.slice(1, 4).map(Number) : null;
}

function isDarkColour([r, g, b]) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
  if (chroma < 14) return false;                       // grey
  let hue = 0;
  if (max === r) hue = 60 * (((g - b) / chroma) % 6);
  else if (max === g) hue = 60 * ((b - r) / chroma + 2);
  else hue = 60 * ((r - g) / chroma + 4);
  if (hue < 0) hue += 360;
  if (hue > 195 && hue < 240) return false;            // the app's own blue-grey
  return lum < 110;
}

test("no night rule paints a dark COLOUR — only tints and neutral chrome", () => {
  const offenders = [];
  for (const [name, css] of [["globals.css", globals], ["visual-pass.css", visual]]) {
    for (const rule of css.matchAll(/([^{}\n]*\.dark[^{}]*)\{([^}]*)\}/g)) {
      const [, selector, body] = rule;
      for (const decl of body.matchAll(/(?<![-a-z])(background|background-color|border-color):\s*([^;]+);/g)) {
        const rgb = channels(decl[2]);
        if (rgb && isDarkColour(rgb)) {
          offenders.push(`${name}  ${selector.trim().slice(0, 54)}  ${decl[1]}: ${decl[2].trim()}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `dark colours still painted at night:\n  ${offenders.join("\n  ")}`);
});

test("the tone systems beyond the cards were fixed too", () => {
  // The two the owner named by sight: a dark yellow icon and a dark maroon one,
  // both in the clock portals, both still wearing their light-mode ink.
  assert.match(globals, /\.unified-app\.dark \.clock-portals \.portal-amber\s+\.module-orb \{ background: rgba\(252, 211, 77, \.15\);\s+color: #fcd34d; \}/);
  assert.match(globals, /\.unified-app\.dark \.clock-portals \.portal-rose\s+\.module-orb \{ background: rgba\(253, 164, 175, \.15\); color: #fda4af; \}/);
  // Work modes, driven by tokens rather than by a rule per chip.
  assert.match(globals, /--mode-office-soft: rgba\(110, 231, 183, \.15\);/);
  assert.match(globals, /--mode-online-soft: rgba\(147, 197, 253, \.15\);/);
  // And a black badge is no longer black-on-near-black.
  assert.match(globals, /\.unified-app\.dark \.black-badge \{ background: rgba\(203, 213, 225, \.16\); color: #e9ecf1; \}/);
});
