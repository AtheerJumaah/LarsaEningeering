/* Larsa Control — the smart card grid.
 *
 * The layout maths is a pure function, so the guarantees the whole feature
 * rests on can be proven directly rather than inferred from a screenshot:
 * "five cards never leave a sixth-card gap" is a property, and a property is
 * something you check for every count, not one you eyeball once.
 *
 * The component is checked by contract against the source, the same way the
 * rest of this suite does it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const src = await read("app/SmartCards.tsx");
const page = await read("app/page.tsx");
const css = await read("app/visual-pass.css");

/* The .tsx cannot be imported directly under node:test without a build step,
   so the two pure functions are transcribed here and kept honest by the
   assertions further down, which check the source still says the same thing. */
const GRID_COLUMNS = 6;

function rowPlanFor(count) {
  if (count <= 0) return [];
  if (count === 1) return [1];
  if (count === 2) return [2];
  const remainder = count % 3;
  let threes = Math.floor(count / 3);
  let pairs = 0;
  if (remainder === 2) pairs = 1;
  else if (remainder === 1) { threes -= 1; pairs = 2; }
  return [...Array(pairs).fill(2), ...Array(threes).fill(3)];
}

function smartDefaultSpans(count) {
  const spans = [];
  rowPlanFor(count).forEach((perRow) => {
    const span = perRow === 1 ? GRID_COLUMNS : GRID_COLUMNS / perRow;
    for (let i = 0; i < perRow; i += 1) spans.push(span);
  });
  return spans.slice(0, count);
}

function layoutHoles(spans, columns = GRID_COLUMNS) {
  let used = 0, holes = 0;
  spans.forEach((span) => {
    const width = Math.min(Math.max(span, 1), columns);
    if (used + width > columns) { holes += columns - used; used = width; }
    else { used += width; }
    if (used === columns) used = 0;
  });
  if (used > 0) holes += columns - used;
  return holes;
}

// ------------------------------------------------------------- the property
test("no card count from 1 to 40 leaves a hole in the grid", () => {
  for (let n = 1; n <= 40; n += 1) {
    const spans = smartDefaultSpans(n);
    assert.equal(spans.length, n, `${n} cards produced ${spans.length} spans`);
    assert.equal(layoutHoles(spans), 0, `${n} cards left a gap: ${JSON.stringify(spans)}`);
  }
});

test("every card gets a span that divides the grid evenly", () => {
  for (let n = 1; n <= 40; n += 1) {
    smartDefaultSpans(n).forEach((span) => {
      assert.ok(GRID_COLUMNS % span === 0, `span ${span} does not divide ${GRID_COLUMNS}`);
    });
  }
});

// ------------------------------------ the counts the brief calls out by name
test("one card is a single full row rather than a stretched sliver", () => {
  assert.deepEqual(smartDefaultSpans(1), [6]);
});

test("two cards sit side by side", () => {
  assert.deepEqual(smartDefaultSpans(2), [3, 3]);
});

test("three cards make one balanced row, not two-then-one", () => {
  assert.deepEqual(rowPlanFor(3), [3]);
  assert.deepEqual(smartDefaultSpans(3), [2, 2, 2]);
});

test("four cards are 2 x 2, never three-then-one", () => {
  assert.deepEqual(rowPlanFor(4), [2, 2]);
  assert.deepEqual(smartDefaultSpans(4), [3, 3, 3, 3]);
});

test("five cards are two wide then three — no empty sixth position", () => {
  assert.deepEqual(rowPlanFor(5), [2, 3]);
  assert.deepEqual(smartDefaultSpans(5), [3, 3, 2, 2, 2]);
  assert.equal(layoutHoles(smartDefaultSpans(5)), 0);
});

test("six cards are three and three — the old layout stranded one alone", () => {
  assert.deepEqual(rowPlanFor(6), [3, 3]);
  assert.deepEqual(smartDefaultSpans(6), [2, 2, 2, 2, 2, 2]);
  // What the previous hardcoded CSS did with six cards: two spanning 3, four
  // spanning 2 -> a third row holding one card and two empty thirds.
  assert.equal(layoutHoles([3, 3, 2, 2, 2, 2]), 4);
});

test("seven and eight cards reflow without an isolated card", () => {
  assert.equal(layoutHoles(smartDefaultSpans(7)), 0);
  assert.equal(layoutHoles(smartDefaultSpans(8)), 0);
  // Seven is 2 + 2 + 3: two pairs of halves, then a row of thirds.
  assert.deepEqual(rowPlanFor(7), [2, 2, 3]);
});

test("the awkward remainder is traded away rather than left dangling", () => {
  // n % 3 == 1 is the case that used to strand one card. It becomes two pairs.
  [4, 7, 10, 13, 16].forEach((n) => {
    assert.ok(!rowPlanFor(n).includes(1), `${n} still produces a lone card`);
    assert.equal(layoutHoles(smartDefaultSpans(n)), 0);
  });
});

test("a hole is actually detected when one exists", () => {
  assert.equal(layoutHoles([2]), 4);          // one third, two thirds empty
  assert.equal(layoutHoles([3]), 3);          // half a row
  assert.equal(layoutHoles([2, 2]), 2);
  assert.equal(layoutHoles([2, 2, 2]), 0);
  assert.equal(layoutHoles([3, 3]), 0);
  assert.equal(layoutHoles([6]), 0);
});

// ------------------------------------------------- source-level guarantees
test("the transcribed maths still matches the component", () => {
  assert.match(src, /export const GRID_COLUMNS = 6;/);
  assert.match(src, /if \(remainder === 2\) \{\s*\n\s*pairs = 1;/);
  assert.match(src, /threes -= 1;\s*\n\s*pairs = 2;/);
  assert.match(src, /export function layoutHoles\(spans: number\[\], columns = GRID_COLUMNS\): number/);
});

test("size presets are a fixed set, not free resizing", () => {
  assert.match(src, /export const CARD_SIZES = \["standard", "wide", "tall", "large", "full"\] as const;/);
  // Every preset is whole columns of the six-column grid, so no preset can
  // produce a fractional column that would never line up.
  const specs = src.slice(src.indexOf("SIZE_SPECS"), src.indexOf("export type SmartCard"));
  [...specs.matchAll(/cols: (\d)/g)].forEach((match) => {
    assert.ok(GRID_COLUMNS % Number(match[1]) === 0, `preset column ${match[1]} does not divide the grid`);
  });
  assert.doesNotMatch(src, /resizable|pixel|onResize|width:\s*\$\{/i);
});

test("a card only offers the sizes it declares support for", () => {
  assert.match(src, /export function supportedSizes\(card: SmartCard\): CardSize\[\]/);
  // The picker is built from the card's own list, not from CARD_SIZES.
  assert.match(src, /\{allowed\.map\(\(size\) => \(/);
  assert.doesNotMatch(src, /\{CARD_SIZES\.map\(\(size\) => \(/);
});

test("a saved layout can never introduce a card the person cannot see", () => {
  // sanitizeLayout intersects with the already-filtered card list, so editing
  // the stored JSON by hand cannot surface an unauthorised module.
  assert.match(src, /const byId = new Map\(cards\.map\(\(card\) => \[card\.id, card\]\)\);/);
  assert.match(src, /const kept = savedOrder\.filter\(\(id\) => byId\.has\(id\)\);/);
  // And an unknown id at render time is skipped rather than thrown on.
  assert.match(src, /if \(!card\) return null;\s*\/\/ an id that outlived its module/);
});

test("an unsupported or unknown size in saved data is dropped, not honoured", () => {
  assert.match(src, /if \(typeof wanted === "string" && \(allowed as string\[\]\)\.includes\(wanted\)\)/);
  assert.match(src, /if \(saved\.version !== LAYOUT_VERSION\) return null;/);
});

test("a layout with a hole cannot be saved", () => {
  const commit = src.slice(src.indexOf("const commit = ()"), src.indexOf("const autoArrange ="));
  assert.match(commit, /if \(layoutHoles\(draftSpans\) > 0\) \{/);
  assert.match(commit, /Those sizes leave a gap in the grid/);
  // The refusal comes before the write, not after it.
  assert.ok(commit.indexOf("layoutHoles(draftSpans)") < commit.indexOf("saveLayout("));
});

test("layouts are stored per user, per page, and per device class", () => {
  assert.match(src, /export function layoutKey\(userId: string, pageKey: string, device: string\) \{\s*\n\s*return `\$\{userId \|\| "anon"\}::\$\{pageKey\}::\$\{device\}`;/);
  assert.match(src, /export function deviceClass\(width: number\)/);
  // Home and Admin pass different page keys, so one cannot overwrite the other.
  assert.match(page, /pageKey="home"/);
  assert.match(page, /pageKey="admin"/);
});

test("reset clears only this page's preference and says access is untouched", () => {
  const reset = src.slice(src.indexOf("const resetDefault ="), src.indexOf("const onDrop ="));
  assert.match(reset, /clearLayout\(key\)/);
  assert.match(reset, /Your access has not changed/);
  // clearLayout removes one key, never the whole store.
  assert.match(src, /delete all\[key\];/);
});

test("mobile ignores desktop presets instead of shrinking them", () => {
  assert.match(src, /if \(device === "mobile"\) return order\.map\(\(\) => GRID_COLUMNS\);/);
  assert.match(css, /\.module-grid\.smart-grid > \.smart-cell \{ grid-column: 1 \/ -1 !important; grid-row: auto !important; \}/);
});

test("cards cannot be navigated into while being rearranged", () => {
  assert.match(src, /inert=\{editing\}/);
  assert.match(css, /\.smart-cell-body\.is-locked \{ pointer-events: none; \}/);
});

test("keyboard and touch users get move controls, not drag only", () => {
  assert.match(src, /aria-label=\{`Move \$\{id\} earlier`\}/);
  assert.match(src, /aria-label=\{`Move \$\{id\} later`\}/);
  assert.match(src, /aria-label=\{`Size for \$\{id\}`\}/);
});

test("the old fixed-span rules no longer fight the computed ones", () => {
  // The hardcoded Home spans and the last-child full-width patch are both
  // neutralised for the smart grid.
  assert.match(css, /\.home-scroll > \.module-grid\.smart-grid \.module-bubble:nth-child\(-n\+2\) \{[\s\S]*?grid-column: auto/);
  assert.match(css, /\.module-grid\.smart-grid > \*:last-child:nth-child\(odd\) \{ grid-column: auto; \}/);
});

test("permission filtering still happens before the grid, not inside it", () => {
  // The grid receives an already-filtered list; it must not be doing its own
  // access checks, which would be the wrong place for them.
  assert.doesNotMatch(src, /hasItemPermission|canOpen|canOpenInSession|access\b.*===/);
  assert.match(page, /already filtered by canOpenInSession above/);
});
