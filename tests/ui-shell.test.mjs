/* Larsa Control — UI refinement contract.
 *
 * These pin the things the refinement pass must never undo: the rounded
 * language, the six large decorated work-area cards, the black sidebar, and
 * the theme/contrast corrections. They read the sources, so they run without
 * a browser alongside the rest of `node --test tests/*.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/page.tsx");
const globals = read("app/globals.css");
const pass = read("app/visual-pass.css");
const css = `${globals}\n${pass}`;

test("the six work-area cards are preserved as large decorated cards", () => {
  // All six are still declared, each with its own accent colour and icon.
  for (const title of ["Time & Attendance", "Performance", "Engineering Management",
    "HR & Skills", "Accounting", "Administration"]) {
    assert.ok(page.includes(`title: "${title}"`), title + " must remain a work-area card");
  }
  for (const colour of ["green", "violet", "blue", "rose", "amber", "slate"]) {
    assert.ok(/color: "([a-z]+)"/.test(page) && page.includes(`color: "${colour}"`),
      colour + " accent must remain");
  }
  // The decorative layers are both still rendered.
  assert.match(page, /className="module-blob"/);
  assert.match(css, /\.module-bubble::after/);
  assert.match(css, /border-radius: 50%/);
  // They stay large, not shrunk into tiles or rows.
  const size = /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) > \.module-bubble \{[^}]*min-height:\s*(\d+)px/.exec(pass);
  assert.ok(size && Number(size[1]) >= 210, "work-area cards must stay large (>=210px tall)");
  // Whole card is the click target.
  assert.match(page, /className=\{`module-bubble \$\{module\.color\}`\} onClick/);
});

test("rounded corners remain the visual language", () => {
  const radius = /\.module-bubble \{[\s\S]*?border-radius: (\d+)px/.exec(globals);
  assert.ok(radius && Number(radius[1]) >= 24, "cards keep a prominently rounded radius");
  for (const rule of [
    /:is\(input, select, textarea\) \{ border-radius: \d+px/,
    /:is\(button, \.btn\) \{ border-radius: \d+px/,
    /:is\(\.modal, \.dialog, \.group-dialog, \.sheet\) \{ border-radius: \d+px/,
    /:is\(\.pill, \.badge, \.black-badge, \.access-pill, \.eyebrow\) \{ border-radius: 999px/,
  ]) assert.match(pass, rule);
  // Nothing squared the cards off.
  assert.ok(!/\.module-bubble\s*\{[^}]*border-radius:\s*0/.test(css),
    "work-area cards must never be squared off");
});

test("the black sidebar identity is preserved", () => {
  assert.match(pass, /aside\.sidebar \.nav-item/);
  assert.match(css, /\.sidebar/);
  assert.ok(!/aside\.sidebar\s*\{[^}]*background:\s*#f/i.test(pass),
    "the sidebar must not be lightened");
});

test("dark mode adapts the decorations rather than removing them", () => {
  for (const colour of ["green", "violet", "rose", "amber", "blue", "slate"]) {
    assert.ok(pass.includes(`.unified-app.dark .module-bubble.${colour}`),
      `${colour} needs a night-mode treatment`);
    assert.ok(new RegExp(`\\.unified-app\\.dark \\.module-bubble\\.${colour}\\s+\\.module-blob`).test(pass),
      `${colour} decoration must stay coloured at night`);
  }
  // The decoration is dimmed, never hidden.
  assert.ok(!/\.unified-app\.dark \.module-blob \{[^}]*display:\s*none/.test(pass));
  assert.match(pass, /\.unified-app\.dark \.module-blob \{ opacity: \.\d+; \}/);
});

test("semantic theme tokens exist for both themes", () => {
  for (const token of ["--surface", "--surface-raised", "--surface-muted", "--text", "--text-2",
    "--text-disabled", "--field-bg", "--field-border", "--focus-ring",
    "--info", "--success", "--warning", "--danger",
    "--st-pending", "--st-approved", "--st-rejected", "--st-draft"]) {
    assert.ok(pass.includes(`${token}:`), token + " must be defined");
  }
  // And redefined for night.
  const darkBlock = /\.unified-app\.dark \{([\s\S]*?)\n\}/.exec(pass);
  assert.ok(darkBlock, "a dark token block must exist");
  for (const token of ["--field-bg", "--focus-ring", "--danger", "--st-approved"]) {
    assert.ok(darkBlock[1].includes(token), token + " must have a night value");
  }
});

test("the named night-mode contrast faults are corrected", () => {
  assert.match(pass, /\.unified-app\.dark aside\.sidebar \.nav-item\.active/);       // weak selection
  assert.match(pass, /\.unified-app\.dark input:not\(\[type="checkbox"\]\)/);        // invisible input text
  assert.match(pass, /\.unified-app\.dark :is\(\.primary, button\.primary/);         // vanishing add button
  assert.match(pass, /recharts-cartesian-axis-tick-value/);                          // chart labels
  assert.match(pass, /:focus-visible \{\s*outline: 2px solid var\(--focus-ring\)/);  // keyboard focus
});

test("theme choice survives a reload", () => {
  // The saved value is read before anything is written back.
  assert.match(page, /const \[themeRead, setThemeRead\] = useState\(false\)/);
  assert.match(page, /if \(!themeRead\) return;\s*\n\s*try \{ localStorage\.setItem\("larsa-control-theme"/);
});

test("permission checks cannot recurse forever", () => {
  // platform-settings used to call hasItemPermission with the same item.
  assert.ok(!/item\.id === "platform-settings"\) return Boolean\(user\.platformAdmin\) \|\| hasItemPermission\(user, item/.test(page),
    "platform-settings must not re-enter hasItemPermission with the same item");
  assert.match(page, /if \(item\.id === "platform-settings"\) \{\s*\n\s*if \(user\.platformAdmin\) return true;/);
});

test("printed documents stay white whatever the app theme", () => {
  assert.match(pass, /@media print \{/);
  assert.match(pass, /background: #ffffff !important/);
  assert.match(pass, /\.unified-app\.dark \* \{[\s\S]*?color: #111111 !important/);
  assert.match(pass, /aside\.sidebar, \.topbar, \.app-header, \.card-tools-fab, \.appearance-fab \{ display: none !important; \}/);
});

test("Accounting shows one shell, not two", () => {
  const cloud = read("public/engines/accounting-cloud.js");
  assert.match(cloud, /suppressEmbeddedShell/);
  // Branding, theme, user chip and sign-out are the duplicated ones.
  assert.match(cloud, /#appTitle,#themeBtn,#signOutBtn,\.topbar \.user-chip\{display:none!important\}/);
  // Accounting's own currency and language controls are NOT suppressed.
  assert.ok(!/curToggle\{display:none/.test(cloud), "the currency toggle must stay");
  assert.ok(!/lang-toggle\{display:none/.test(cloud), "the language toggle must stay");
  // Project titles stop hiding under the sticky bar.
  assert.match(cloud, /scroll-margin-top/);
});

test("Home reports red only for genuinely overdue work", () => {
  assert.match(page, /tone: weekApproved >= weekTarget \? "done" : "open"/);
  assert.ok(!/tone: weekApproved >= weekTarget \? "done" : awaiting \? "open" : "due"/.test(page),
    "an unmet weekly target must not be reported as overdue");
});

test("Home stops repeating the same figure three times", () => {
  // The board no longer restates today's shift and the weekly points.
  assert.match(page, /home-board-grid-lean/);
  assert.ok(!/<small>Weekly points<\/small><b>\{summary\.weekApproved\}/.test(page),
    "weekly points must not be repeated in the reminder board");
  // Continue Working gained a short recent list.
  assert.match(page, /recentTrailItems/);
  assert.match(page, /larsa-control-recent-trail/);
});

test("Install uses the browser's real install when there is one", () => {
  const layout = read("app/layout.tsx");
  // The event is caught in the document head, before React exists.
  assert.match(layout, /larsa-install-capture/);
  assert.match(layout, /beforeinstallprompt/);
  assert.match(layout, /window\.__larsaInstall/);
  // The page adopts what the head parked instead of only listening from mount.
  assert.match(page, /__larsaInstall\?\.event/);
  assert.match(page, /"larsa:installable"/);
  // prompt() is reached from the click, with no await before it.
  assert.match(page, /const prompt = installPrompt \|\| \(window as WindowWithInstall\)\.__larsaInstall\?\.event \|\| null;/);
  // Exactly one beforeinstallprompt registration is left in the page.
  assert.equal((page.match(/window\.addEventListener\("beforeinstallprompt"/g) || []).length, 1,
    "the duplicate listener is gone");
  assert.equal((page.match(/window\.removeEventListener\("beforeinstallprompt"/g) || []).length, 1,
    "and it is still cleaned up");
  /* An install that already happened is the commonest reason the browser stays
     silent. getInstalledRelatedApps can only answer that if the manifest lists
     the app as its own related application, so the button knows to stand down
     instead of offering an install that cannot happen. */
  const manifest = JSON.parse(read("public/manifest.webmanifest"));
  assert.ok(Array.isArray(manifest.related_applications)
    && manifest.related_applications.some((a) => a.platform === "webapp" && /manifest\.webmanifest$/.test(a.url || "")),
    "the manifest must list itself as a related webapp");
  assert.equal(manifest.prefer_related_applications, false);
  assert.match(page, /getInstalledRelatedApps/);
  // The manual steps are the fallback, and say which platform is yours.
  assert.match(page, /step\.id === os \? "match" : undefined/);
  assert.match(pass, /\.install-grid article\.match/);
});

test("hovering a card is unmistakable", () => {
  // Grows and lifts, with a ring in the card's own colour.
  const hover = /\n  \.module-bubble:hover \{([\s\S]*?)\n  \}/.exec(pass);
  assert.ok(hover, "the cards need a hover rule in the refinement layer");
  assert.match(hover[1], /transform: translateY\(-\d+px\) scale\(1\.0\d+\)/);
  assert.match(hover[1], /box-shadow:[\s\S]*?0 0 0 2px/);
  // Only for real pointers: a sticky :hover after a tap would strand a card.
  assert.match(pass, /@media \(hover: hover\) and \(pointer: fine\) \{/);
  // Keyboard focus matches, and pressing still reads as a press.
  assert.match(pass, /\.module-bubble:focus-visible \{[\s\S]*?transform: translateY\(-\d+px\) scale\(1\.0\d+\)/);
  assert.match(pass, /\.module-bubble:active \{[\s\S]*?scale\(\.99\d*\)/);
  assert.match(pass, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.module-bubble:hover, \.module-bubble:focus-visible \{ transform: none; \}/);
});

test("density changes rounding and spacing, not just padding", () => {
  for (const token of ["--radius-card", "--radius-panel", "--radius-tile", "--grid-gap"]) {
    assert.ok(new RegExp(`:root \\{[\\s\\S]*?${token}:`).test(pass), token + " must be a token");
    assert.ok(new RegExp(`\\[data-density="compact"\\] \\{[\\s\\S]*?${token}:`).test(pass),
      token + " must have a compact value");
  }
  const roomy = Number(/:root \{[\s\S]*?--radius-card: (\d+)px/.exec(pass)[1]);
  const tight = Number(/\[data-density="compact"\] \{[\s\S]*?--radius-card: (\d+)px/.exec(pass)[1]);
  assert.ok(roomy > tight, "comfortable must be rounder than compact");
  const roomyGap = Number(/:root \{[\s\S]*?--grid-gap: (\d+)px/.exec(pass)[1]);
  const tightGap = Number(/\[data-density="compact"\] \{[\s\S]*?--grid-gap: (\d+)px/.exec(pass)[1]);
  assert.ok(roomyGap > tightGap, "comfortable must be more spaced than compact");
  assert.match(pass, /\.unified-app \.module-bubble \{ border-radius: var\(--radius-card\); \}/);
  /* The cards are buttons, and the generic control radius is written at the
     same weight. Losing that tie is what squared them off, so the card rule
     must stay both prefixed and last. */
  assert.ok(pass.indexOf(".unified-app .module-bubble { border-radius: var(--radius-card); }")
    > pass.indexOf(".unified-app :is(button, .btn) { border-radius:"),
    "the card radius must be stated after the generic control radius");
  assert.match(pass, /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) \{ gap: var\(--grid-gap\); \}/);
  // Compact must actually reach the six home cards, whose own rule is stronger.
  assert.match(pass, /\[data-density="compact"\] \.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) > \.module-bubble \{/);
});

test("the brand mark is visible on its own tile", () => {
  /* The blanket sidebar contrast rule sets every span's colour with
     !important. The mark and the icons are painted with currentColor, so on a
     white tile they were being drawn near-white on white — an empty square.
     Both the tile and the glyph inside it must be named to undo that. */
  assert.match(pass, /aside\.sidebar \.nav-item\.nav-home \.nav-code,[\s\S]*?background: #ffffff !important; color: #0b0b0c !important;/);
  assert.match(pass, /aside\.sidebar \.nav-item\.nav-home \.nav-code \.larsa-mark,[\s\S]*?color: #0b0b0c !important;/);
  assert.match(pass, /aside\.sidebar \.nav-item:hover \.nav-code svg \{ color: #0b0b0c !important; \}/);
  // Hover keeps the sidebar's own language rather than the old white pill,
  // which was leaving light text on a white background.
  assert.match(pass, /aside\.sidebar \.nav-item:hover \{ background: rgba\(255, 255, 255, \.14\)/);
  // The Home subtitle is readable rather than 62% opacity on near-black.
  assert.match(pass, /aside\.sidebar \.nav-item\.nav-home small \{ color: #c6ccd6 !important; opacity: 1;/);
  assert.match(page, /isHome \? "nav-home" : ""/);
});

test("the sidebar folds away and Home survives without it", () => {
  // A fold control in the sidebar, a reopen control in the bar.
  assert.match(page, /className="collapse-menu"/);
  assert.match(page, /aria-label="Hide the sidebar"/);
  assert.match(page, /onClick=\{\(\) => \{ setMenuOpen\(true\); setNavFolded\(false\); \}\}/);
  assert.match(page, /navCollapsed \? "nav-collapsed" : ""/);
  assert.match(page, /larsa-control-nav-collapsed/);
  // Wide screens only: on a phone the sidebar is already a drawer.
  assert.match(pass, /@media \(min-width: 1025px\) \{[\s\S]*?\.unified-app\.nav-collapsed \{ grid-template-columns: 0 minmax\(0, 1fr\); \}/);
  /* Without this the workspace auto-places into the column being closed and
     the whole app renders into a 0px strip. */
  assert.match(pass, /\.unified-app > \.main-shell \{ grid-column: 2; \}/);
  // Home is in the bar too, so folding the sidebar never strands anyone.
  assert.match(page, /className="top-home"/);
  assert.match(page, /choose\(OVERVIEW_ITEM, "home"\)/);
  assert.match(page, /const OVERVIEW_ITEM: Item = GROUPS\[0\]\.items\[0\];/);
});

test("card text sits where it was asked to sit", () => {
  // The six cards: lifted off the bottom edge and indented.
  assert.match(pass, /> \.module-bubble > \.module-copy \{\s*\n\s*align-content: center;\s*\n\s*padding-inline-start: 6px;/);
  assert.match(pass, /> \.module-bubble > \.module-open \{\s*\n\s*padding-inline-start: 6px;/);
  // The accounting lists line up with the heading, not with the card edge.
  assert.match(pass, /\.accounting-card \.accounting-links \{ padding-inline-start: 72px; \}/);
  assert.match(pass, /@media \(max-width: 760px\) \{\s*\n\s*\.accounting-card \.accounting-links \{ padding-inline-start: 0; \}/);
});

test("responsive rules keep the six cards as cards on small screens", () => {
  assert.match(pass, /@media \(max-width: 700px\) \{/);
  // On a phone the grid becomes one column of full-width cards...
  assert.match(pass, /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  // ...that keep a card's height and rounding rather than becoming rows.
  assert.match(pass, /> \.module-bubble \{ min-height: \d+px; padding: \d+px; border-radius: (?:\d+px|var\(--radius-card-sm\)); \}/);
  // Decorations scale down rather than disappear.
  assert.match(pass, /\.module-bubble::after, \.module-bubble \.module-blob \{ width: \d+px/);
});
