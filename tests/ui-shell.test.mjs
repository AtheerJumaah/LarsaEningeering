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

test("responsive rules keep the six cards as cards on small screens", () => {
  assert.match(pass, /@media \(max-width: 700px\) \{/);
  // On a phone the grid becomes one column of full-width cards...
  assert.match(pass, /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  // ...that keep a card's height and rounding rather than becoming rows.
  assert.match(pass, /> \.module-bubble \{ min-height: \d+px; padding: \d+px; border-radius: \d+px; \}/);
  // Decorations scale down rather than disappear.
  assert.match(pass, /\.module-bubble::after, \.module-bubble \.module-blob \{ width: \d+px/);
});
