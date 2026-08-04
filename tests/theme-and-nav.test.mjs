/* Larsa Control — navigation channels, and two features that were removed.
 *
 * This file used to cover a Classic/Larsa theme selector as well. That was
 * taken out at the owner's request — the app has one appearance again, plus
 * the light/dark toggle it always had. The navigation half stays, because the
 * Engineering Management fix is a separate thing and still load-bearing.
 *
 * The removal assertions are here on purpose. A feature that was deliberately
 * dropped is exactly the kind of thing that creeps back in later, and a test
 * is a cheaper way to say "we decided against this" than a comment nobody
 * reads.
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
  /* This used to name org-structure directly. The area has four sections in
     the sidebar now, so the channel is decided by the one table that says
     which ids belong to it — the same table the permission check reads. */
  assert.match(page, /if \(ENGINEERING_ITEM_TABS\[item\.id\]\) return "engineering";/);
  assert.match(page, /if \(ENGINEERING_ITEM_TABS\[item\.id\]\) return canSeeOrgPortal\(\);/);
});

test("that channel resolves to a real sidebar group", () => {
  assert.match(page, /engineering: \{\s*\n\s*label: "Engineering Management",/);
  // Built from the same GROUPS registry the rest of the nav reads, not a
  // second hardcoded list that could drift away from it.
  assert.match(page, /GROUPS\.find\(\(group\) => group\.label === "Engineering Management"\)!\.items\s*\n\s*\.filter/);
  assert.match(page, /label: "Engineering Management",\s*\n\s*items: \[/);
});

test("the Home card opens it on its own channel, not on Home", () => {
  assert.match(page, /\{ id: "org-structure", channel: "engineering" as const, title: "Engineering Management"/);
  // The old value is what produced the bug: navChannel stayed "home", so
  // contextGroup was null and the sidebar fell back to just Home.
  assert.doesNotMatch(page, /\{ id: "org-structure", channel: "home" as const/);
});

test("the sidebar still filters every group by access", () => {
  assert.match(page, /items: group\.items\.filter\(\(item\) => canOpenInSession\(sessionUser, item, sessionMethod\)\)/);
  assert.match(page, /\.filter\(\(group\) => group\.items\.length\)/);
});

// -------------------------------------------------------- removed: themes
test("there is no theme selector — one appearance, plus light and dark", () => {
  assert.doesNotMatch(page, /theme-picker|data-theme|setAppearance|larsa-control-appearance/);
  assert.doesNotMatch(page, /Larsa Executive|LARSA Executive|Custom Theme/);
  // The light/dark toggle is untouched; it predates all of this.
  assert.match(page, /const \[dark, setDark\] = useState\(false\);/);
  assert.match(page, /aria-label="Toggle theme"/);
});

test("no theme stylesheet survives either", () => {
  assert.doesNotMatch(css, /data-theme=|theme-picker|--l-900|--exec-ink/);
  // The card decorations a theme had switched off are back to being simply
  // whatever the one appearance says.
  assert.doesNotMatch(css, /\.module-blob \{ display: none; \}/);
});

// -------------------------------------------- removed: clocking others in
test("nobody can clock another person in or out", () => {
  // The handler, the panel and the state it used are all gone — not hidden
  // behind a permission, which would leave the capability one flag away.
  assert.doesNotMatch(page, /punchOther|clock-others|Clock someone else/);
  assert.doesNotMatch(page, /cannot clock other people in or out/);
});

test("but correcting and trimming recorded hours is untouched", () => {
  // Those are separate features and were not part of the removal: a
  // forgotten clock-out still has to be fixable.
  assert.match(page, /const mayAdjustHours = Boolean\(user && \(\(\) => \{/);
  assert.match(page, /Trim or remove recorded hours/);
  assert.match(page, /Add or fix past hours/);
  assert.match(page, /const trimSession = useCallback/);
  assert.match(page, /const resetSession = useCallback/);
});

test("clocking yourself in and out still works, and still guards a double-tap", () => {
  assert.match(page, /const punchClock = useCallback/);
  assert.match(page, /const punchBreak = useCallback/);
  // The guard stays short and honest: it absorbs a real double-fire and
  // returns false rather than claiming success while doing nothing.
  assert.match(page, /Date\.now\(\) - new Date\(latest\.time\)\.getTime\(\) < 1200/);
  assert.match(page, /< 1200\) \{\s*\n\s*return false;/);
});
