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

test("Approval Flow is edited in HR & Skills, over the same flowConfig", () => {
  /* It began as a pointer to the engine's setup card, because the engine
     owned that screen. People still could not rearrange a chain there — three
     fixed dropdowns, no way to move a step — so it is now a native screen.
     It writes the SAME flowConfig the engine reads, which is what keeps the
     two views honest with each other. */
  assert.match(page, /\{ id: "hr-approval-flow", label: "Approval Flow",[^}]*native: "approvalFlow" \}/);
  assert.match(page, /if \(item\.id === "hr-approval-flow"\) return "hr";/);
  assert.match(page, /"hr-approval-flow": \["view", "add", "edit", "delete", "approve", "manage"\]/);
  assert.match(page, /active\.native === "approvalFlow"/);
  assert.match(page, /function ApprovalFlowCentre\(/);
  // Steps can be reordered, added and removed — the thing that was missing.
  assert.match(page, /const move = \(at: number, by: number\) => \{/);
  assert.match(page, /\[next\[at\], next\[to\]\] = \[next\[to\], next\[at\]\];/);
  assert.match(page, />Move up<\/button>/);
  assert.match(page, />Move down<\/button>/);
  assert.match(page, /Add approver/);
  // Saving is permission-gated and writes the shared store the engine reads.
  assert.match(page, /const saveApprovalFlow = useCallback/);
  assert.match(page, /hasItemPermission\(actor, item, "edit"\)\) \{\s*\n\s*notify\("Your account cannot change approval flows\."\);/);
  assert.match(page, /store\.flowConfig = flowConfig;/);
  assert.match(page, /refreshStaffEngine\(\);/);
  // Nobody approves their own request, nobody appears twice, three steps max.
  assert.match(page, /\.filter\(\(id, at, all\) => all\.indexOf\(id\) === at\)/);
  assert.match(page, /\.filter\(\(id\) => id !== employeeId\)/);
  assert.match(page, /\.slice\(0, 3\);/);
  // And the deliberately-removed duplicate approval screen stays gone.
  assert.ok(!/approval-flows/.test(page), "the duplicate approval screen must stay gone");
});
