import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* The phone's system Back button. This is a single-URL app — every screen is
 * React state — so the browser used to hold exactly one history entry and the
 * first system Back press closed the app from anywhere. These tests pin the
 * sentinel design in app/page.tsx and the shared overlay registry in
 * app/backstack.ts, so a refactor cannot quietly bring the old behaviour back.
 */

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const backstack = readFileSync(new URL("../app/backstack.ts", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../app/Dialog.tsx", import.meta.url), "utf8");
const cardTools = readFileSync(new URL("../app/CardTools.tsx", import.meta.url), "utf8");
const smartCards = readFileSync(new URL("../app/SmartCards.tsx", import.meta.url), "utf8");
const platform = readFileSync(new URL("../app/PlatformSettings.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("a sentinel history entry is armed on load and a popstate listener handles system Back", () => {
  // One entry to consume, so the first press reaches the app instead of closing it.
  assert.match(page, /history\.replaceState\(\{ larsa: "base" \}/);
  assert.match(page, /history\.pushState\(\{ larsa: "sentinel" \}/);
  assert.match(page, /window\.addEventListener\("popstate", onPop\)/);
  // The listener is removed on unmount — no duplicate handlers across remounts.
  assert.match(page, /return \(\) => window\.removeEventListener\("popstate", onPop\)/);
});

test("the press is handled in the required order: overlays, then in-app back, then Home, then exit", () => {
  const handler = page.slice(page.indexOf("const handleSystemBack"), page.indexOf("const systemBackHandlerRef"));
  const order = [
    "popBackCloser()",          // dialogs, snapshot viewer, popovers
    "setBellOpen(false)",       // notification dropdown
    "setMenuOpen(false)",       // navigation drawer
    "setInstallHelp(false)",    // install sheet
    "setAccountingGate(null)",  // accounting identity gate
    "setAccessMode(null)",      // sign-in sub-screens
    "goBack()",                 // the app's own previous-screen stack
    'active.id !== "overview"', // anywhere else: return to Home
    "flags.armed",              // and only then the double-press exit flow
  ];
  let at = -1;
  for (const marker of order) {
    const next = handler.indexOf(marker);
    assert.ok(next > at, `"${marker}" must come after the previous step in handleSystemBack`);
    at = next;
  }
});

test("Back at Home asks for a second press within two seconds instead of exiting at once", () => {
  assert.match(page, /Press back again to exit/);
  // The exit window: armed for 2000ms, then the sentinel is re-armed and the person stays.
  assert.match(page, /\}, 2000\)/);
  // A second press is released to the system rather than intercepted for ever.
  const handler = page.slice(page.indexOf("const handleSystemBack"), page.indexOf("const systemBackHandlerRef"));
  assert.match(handler, /flags\.armed = false;\s*\n\s*setExitHint\(false\);/);
  assert.match(handler, /window\.history\.back\(\)/);
});

test("navigating in-app never traps the person: every handled press re-arms exactly one sentinel", () => {
  const handler = page.slice(page.indexOf("const handleSystemBack"), page.indexOf("const systemBackHandlerRef"));
  // Each overlay/navigation branch ends by re-arming; the exit branch does not.
  const rearms = handler.match(/armSentinel\(\);/g) || [];
  assert.ok(rearms.length >= 8, `expected every handled branch to re-arm (found ${rearms.length})`);
  // The departure path clears itself if the app is still visible, so a stale
  // history stack after refresh cannot leave Back permanently dead.
  assert.match(handler, /flags\.leaving = window\.setTimeout/);
});

test("the overlay registry closes the top-most layer first and survives a closer that throws", () => {
  assert.match(backstack, /export function registerBackCloser/);
  assert.match(backstack, /export function popBackCloser/);
  assert.match(backstack, /stack\.pop\(\)/);
  assert.match(backstack, /try \{ close\(\); \} catch/);
});

test("dialogs, the snapshot viewer, the appearance popover, and layout editing all register", () => {
  assert.match(dialog, /registerBackCloser\(\(\) => settle\(/);
  assert.match(platform, /registerBackCloser\(\(\) => \{ setPitRow\(null\); setPitData\(null\); \}\)/);
  assert.match(cardTools, /registerBackCloser\(\(\) => setOpen\(false\)\)/);
  assert.match(smartCards, /registerBackCloser\(finishOnOutside\)/);
});

test("the exit hint is a themed, non-interactive toast above the safe area", () => {
  assert.match(page, /className="exit-hint" role="status"/);
  assert.match(css, /\.exit-hint \{/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /safe-area-inset-bottom/);
});

test("the push deep link (?n=) still strips itself without fighting the sentinel", () => {
  // replaceState on the current entry only rewrites the URL; the sentinel
  // logic never reads entry state, so both can coexist.
  assert.match(page, /params\.delete\("n"\)/);
  assert.match(page, /window\.history\.replaceState\(\{\}, "", window\.location\.pathname/);
});

test("Approval Flow is reachable from HR & Skills without duplicating the editor", () => {
  // A pointer to the same engine screen, not a second editor: same section,
  // channel pinned to hr, and its own permission row.
  assert.match(page, /engineItem\("staff", "hr-approval-flow", "Approval Flow",[^)]*"approvals"\)/);
  assert.match(page, /if \(item\.id === "hr-approval-flow"\) return "hr";/);
  assert.match(page, /"hr-approval-flow": \["view", "add", "edit", "delete", "approve", "manage"\]/);
  // The alias must not overwrite the canonical permission snapshot the engine receives.
  assert.match(page, /if \(result\[item\.section!\]\) return;/);
  // And the deliberately-removed duplicate approval screen stays gone.
  assert.ok(!/approval-flows/.test(page), "the duplicate approval screen must stay gone");
});
