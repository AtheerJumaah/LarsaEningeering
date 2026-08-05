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
  /* The span moved from the bubble to the .smart-cell wrapper, so this rule
     now lists both the direct and the nested bubble. The card metric it sets
     is unchanged, which is the thing worth asserting. */
  const size = /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\)[^{]*> \.module-bubble \{[^}]*min-height:\s*(\d+)px/.exec(pass);
  assert.ok(size && Number(size[1]) >= 210, "work-area cards must stay large (>=210px tall)");
  // Whole card is the click target.
  assert.match(page, /className=\{`module-bubble \$\{module\.color\}`\} onClick/);
  // Still one grid, still permission-filtered before it is handed over.
  assert.match(page, /<SmartCardGrid/);
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
  // The parked event is still what the click reaches for first.
  assert.match(page, /let prompt = installPrompt \|\| bridge\?\.event \|\| null;/);
  /* Chromium settles on "this can be installed" a moment AFTER load, so a
     click landing in that gap found nothing and jumped to the written steps —
     the "sometimes it shows options instead of installing" report. It now
     waits briefly for the real dialog, and only falls back when the browser
     has no such API at all (Safari, Firefox), where waiting would add a pause
     before the only way in. Two seconds sits inside Chrome's five-second user
     activation window, so the prompt() still counts as coming from the click. */
  assert.match(page, /prompt = await waitForInstallEvent\(2000\);/);
  assert.match(page, /if \(!prompt && installApiExists\(\)\) \{/);
  assert.match(page, /"onbeforeinstallprompt" in window/);
  // Waiting listens for both shapes: the head script's announcement and a raw late event.
  assert.match(page, /window\.addEventListener\("larsa:installable", onArrival\);/);
  assert.match(page, /window\.addEventListener\("beforeinstallprompt", onArrival\);/);
  // An install that already happened is answered, not met with instructions.
  assert.match(page, /if \(installed \|\| bridge\?\.installed\) \{/);
  assert.match(page, /already installed — open it from your home screen/);
  // Exactly one persistent beforeinstallprompt registration in the effect
  // (the waiter adds its own only while a click is waiting, and removes it).
  assert.equal((page.match(/window\.addEventListener\("beforeinstallprompt", onPrompt\)/g) || []).length, 1,
    "the duplicate listener is gone");
  assert.equal((page.match(/window\.removeEventListener\("beforeinstallprompt", onPrompt\)/g) || []).length, 1,
    "and it is still cleaned up");
  assert.match(page, /window\.removeEventListener\("beforeinstallprompt", onArrival\);/,
    "the waiter must not leave a listener behind");
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
  // Compact must reach the nested bubble too, or the smart grid would sit at
  // comfortable spacing while everything around it tightened.
  assert.match(pass, /\[data-density="compact"\] \.module-grid[^,]*> \.smart-cell > \.smart-cell-body > \.module-bubble/);
  // Compact must actually reach the six home cards, whose own rule is stronger.
  // The selector now also lists the nested bubble, so the brace no longer
  // follows immediately — the selector itself is what matters.
  assert.match(pass, /\[data-density="compact"\] \.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\) > \.module-bubble[,\s]/);
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

test("installed on a desktop, the bar keeps clear of the window controls", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest"));
  /* window-controls-overlay hands the app the title bar and then draws the
     minimise/maximise/close buttons on top of it — which put them straight
     over the clocks and the icon buttons. */
  assert.ok(!manifest.display_override.includes("window-controls-overlay"),
    "the app must not ask for the window-controls overlay");
  assert.equal(manifest.display, "standalone");
  // An app installed before that change keeps its old manifest for a while,
  // so the bar reserves the controls' strip on both ends regardless.
  assert.match(pass, /@media \(display-mode: window-controls-overlay\) \{/);
  assert.match(pass, /padding-right: max\(18px, calc\(100vw - env\(titlebar-area-width/);
  assert.match(pass, /padding-left: max\(22px, calc\(env\(titlebar-area-x/);
  // An overlay window with no draggable region cannot be moved.
  assert.match(pass, /-webkit-app-region: drag/);
  // The cache name must move, or the old manifest stays precached.
  const version = /larsa-control-v(\d+)/.exec(read("public/sw.js"));
  assert.ok(version && Number(version[1]) >= 19, "bump the cache when the manifest changes");
  /* The title bar the browser draws for the installed window is painted in the
     theme colour. Black above a near-white app is a band bolted on top; the
     app's own background makes the two surfaces meet as one. */
  assert.equal(manifest.theme_color, "#f7f7f5");
  assert.match(read("app/layout.tsx"), /themeColor: "#f7f7f5"/);
  // And it follows the light/dark toggle rather than being fixed at build time.
  assert.match(page, /meta\[name="theme-color"\]/);
  assert.match(page, /meta\.setAttribute\("content", dark \? "#0d0f14" : "#f7f7f5"\)/);
});

test("Back steps through the app, on every page", () => {
  /* The browser's own Back leaves a single-page app entirely, so the trail of
     areas actually visited has to be kept here. */
  assert.match(page, /const \[navHistory, setNavHistory\] = useState<Item\[\]>\(\[\]\)/);
  assert.match(page, /className="top-back"/);
  assert.match(page, /onClick=\{goBack\}/);
  // Only shown when there is somewhere to go back to.
  assert.match(page, /\{navHistory\.length > 0 && \(/);
  // A step is recorded only once the navigation is certain to happen — after
  // the access check and the accounting gate have had their say.
  assert.match(page, /if \(record && activeRef\.current && activeRef\.current\.id !== item\.id\)/);
  const chooseBody = /const choose = \(item: Item[\s\S]*?\n  \};/.exec(page)[0];
  assert.ok(chooseBody.indexOf("canOpenInSession") < chooseBody.indexOf("setNavHistory"),
    "a refused navigation must not record a step");
  assert.ok(chooseBody.indexOf("setAccountingGate") < chooseBody.indexOf("setNavHistory"),
    "a gated navigation must not record a step");
  // Going back must not push the step it is undoing, or the two ping-pong.
  assert.match(page, /choose\(previous, channelForItem\(previous\), false\)/);
  assert.match(pass, /\.unified-app \.top-back,\s*\n\.unified-app \.top-home \{/);
});

test("the page title outweighs its own subtitle", () => {
  /* Tailwind's reset drops h1 to the body weight, which left the small grey
     description as the boldest text in the bar. */
  const title = /\.unified-app \.page-heading h1 \{[\s\S]*?font-weight: (\d+)/.exec(pass);
  const sub = /\.unified-app \.page-heading p \{[\s\S]*?font-weight: (\d+)/.exec(pass);
  assert.ok(title && sub, "both parts of the heading need a stated weight");
  assert.ok(Number(title[1]) > Number(sub[1]),
    "the title must be heavier than the line describing it");
});

test("the clock labels read from the left", () => {
  assert.match(globals, /\.clocks span \{[\s\S]*?text-align: start;/);
  assert.ok(!/\.clocks span \{[^}]*text-align: right/.test(globals),
    "the clock chips must not be right-aligned");
});

test("responsive rules keep the six cards as cards on small screens", () => {
  assert.match(pass, /@media \(max-width: 700px\) \{/);
  // On a phone the grid becomes one column of full-width cards...
  assert.match(pass, /\.module-grid:not\(\.quick-grid\):not\(\.accounting-grid\):not\(\.smart-grid\) \{ grid-template-columns: minmax\(0, 1fr\) !important; \}/);
  // The smart grid collapses to one column its own way, so the blanket
  // !important rule is scoped off it rather than fighting the computed spans.
  assert.match(pass, /\.module-grid\.smart-grid > \.smart-cell \{ grid-column: 1 \/ -1 !important; grid-row: auto !important; \}/);
  // ...that keep a card's height and rounding rather than becoming rows.
  assert.match(pass, /> \.module-bubble \{ min-height: \d+px; padding: \d+px; border-radius: (?:\d+px|var\(--radius-card-sm\)); \}/);
  assert.match(pass, /> \.smart-cell > \.smart-cell-body > \.module-bubble \{ min-height: \d+px/);
  // Decorations scale down rather than disappear.
  assert.match(pass, /\.module-bubble::after, \.module-bubble \.module-blob \{ width: \d+px/);
});

test("the installed app replaces itself when a new version ships", () => {
  /* The worker always took over on activate, but the PAGE kept running the
     old code until somebody happened to close and reopen it — a shipped fix
     could sit unseen on a phone for days. The app now asks for a newer worker
     on load and whenever it returns to the foreground, and reloads once when
     one takes over. */
  assert.match(page, /registration\.update\(\)\.catch\(\(\) => undefined\);/);
  assert.match(page, /document\.addEventListener\("visibilitychange", updateCheck\);/);
  assert.match(page, /navigator\.serviceWorker\?\.addEventListener\("controllerchange", onControllerChange\);/);
  /* A first install has no previous controller; reloading then would restart
     the app under the person's hands, and could loop. */
  assert.match(page, /const hadController = Boolean\(navigator\.serviceWorker\?\.controller\);/);
  assert.match(page, /if \(!hadController \|\| reloading\) return;/);
  // And every listener it adds is removed again.
  assert.match(page, /navigator\.serviceWorker\?\.removeEventListener\("controllerchange", onControllerChange\);/);
  assert.match(page, /if \(updateCheck\) document\.removeEventListener\("visibilitychange", updateCheck\);/);
  // The dead end in the sheet is now an action, not an instruction.
  assert.match(page, /Reload and try again/);
});

test("Platform Settings says when backups will not load instead of loading for ever", () => {
  const panel = read("app/PlatformSettings.tsx");
  /* A browser left open overnight reaches the backup RPC with an expired
     token. The failure used to be swallowed, so the schedule, the addresses
     and the snapshot list never appeared and the feature looked missing. */
  assert.match(panel, /if \(attempt === 0\) \{\s*\n\s*try \{ await client\.auth\.refreshSession\(\); \}/);
  assert.match(panel, /return loadBackups\(1\);/);
  assert.match(panel, /setBackupError\(String\(s\.error\.message/);
  // And the panel offers a way out rather than an eternal "Loading…".
  assert.match(panel, /backupLoading \? <p className="org-none">Loading backup settings\.\.\.<\/p> : \(/);
  assert.match(panel, /onClick=\{\(\) => loadBackups\(\)\}>Try again<\/button>/);
  // The controls people were looking for are all still there.
  for (const control of ["Email a copy to", "Back up now", "Snapshots", "interval_hours", "retain_days"]) {
    assert.ok(panel.includes(control), `the backup panel must still offer ${control}`);
  }
});
