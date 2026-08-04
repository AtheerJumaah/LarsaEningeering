/* Larsa Control — two things the owner asked for after using the app.
 *
 *   1. Department on the user form was a free-text box. That is how a company
 *      ends up with "Structural", "structural" and "Struct." as three separate
 *      departments and a report that counts them as three. It reads from the
 *      Engineering Management structure now.
 *
 *   2. Engineering Management is one screen with four sections behind tabs, and
 *      only the screen itself was in the sidebar — so from the outside it
 *      looked like a single page and the other three were invisible until you
 *      were already inside. Each section is listed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

// ------------------------------------------------------- the department list
test("Department is chosen from a list, not typed", () => {
  assert.match(page, /<label>\s*\n\s*Department\s*\n\s*<select value=\{draft\.department \|\| ""\}/);
  // The old free-text input must not survive alongside it.
  assert.doesNotMatch(page, /<label>Department<input value=\{draft\.department/);
});

test("the list is the company's own structure, not a second copy of it", () => {
  /* effectiveOrg is the same reader the Engineering Management screen uses:
     the saved chart when there is one, otherwise the departments implied by
     the staff list. Two lists would drift apart the first time somebody added
     a department in one place. */
  assert.match(page, /const orgDepartments = useMemo\(\s*\n\s*\(\) => effectiveOrg\(users\)\.departments\.map/);
});

test("a department already on somebody's record is never silently dropped", () => {
  /* Without this, opening an account to change a phone number and pressing
     save would clear a department that happens not to be in the chart. */
  assert.match(page, /\[\.\.\.orgDepartments, String\(draft\?\.department \|\| ""\)\.trim\(\)\]/);
  assert.match(page, /const departmentChoices = useMemo/);
  // Case-insensitive de-duplication, so "Structural" and "structural" collapse.
  assert.match(page, /const key = name\.toLowerCase\(\);\s*\n\s*if \(!key \|\| seen\.has\(key\)\) return;/);
});

test("and an empty chart says where to go rather than offering nothing", () => {
  assert.match(page, /No departments defined yet — add them in Engineering Management, under Structure\./);
  assert.match(page, /<option value="">No department selected<\/option>/);
});

// ------------------------------------------- the four engineering sections
test("all four Engineering Management sections are in the sidebar", () => {
  for (const [id, label] of [
    ["org-structure", "Engineering Dashboard"],
    ["org-chart", "Structure"],
    ["org-team-time", "Team Timesheets"],
    ["org-team-points", "Team Performance"],
  ]) {
    assert.match(page, new RegExp(`\\{ id: "${id}", label: "${label}"`), `${label} is missing`);
  }
  // All four are the same screen; only the tab differs.
  assert.match(page, /const ENGINEERING_ITEM_TABS: Record<string, EngineeringTab> = \{\s*\n\s*"org-structure": "dashboard",\s*\n\s*"org-chart": "structure",\s*\n\s*"org-team-time": "time",\s*\n\s*"org-team-points": "performance",/);
});

test("org-structure keeps its id, and so keeps everything pointing at it", () => {
  /* The Home card, the recent list and the permission check all name this id.
     Renaming it to match its new label would have broken all three for the
     sake of tidiness. Only the label changed. */
  assert.match(page, /\{ id: "org-structure", channel: "engineering" as const, title: "Engineering Management"/);
  assert.match(page, /"org-structure": "dashboard",/);
});

test("the two management sections are hidden from people who manage nobody", () => {
  /* Shown-and-empty is worse than absent: it reads as a broken page rather
     than as one that is not yours. */
  assert.match(page, /const ENGINEERING_MANAGER_ITEMS = new Set\(\["org-team-time", "org-team-points"\]\);/);
  assert.match(page, /\.filter\(\(item\) => !ENGINEERING_MANAGER_ITEMS\.has\(item\.id\) \|\| managesOthers\)/);
  // The sidebar asks the same question the screen asks itself.
  assert.match(page, /const managesOthers = useMemo\(\s*\n\s*\(\) => isResponsibleForOthers\(effectiveOrg\(accessUsers\), sessionUser, accessUsers\)/);
});

test("and reaching one another way falls back rather than showing a blank page", () => {
  assert.match(page, /openTab && \(manages \|\| \(openTab !== "time" && openTab !== "performance"\)\) \? openTab : "dashboard";/);
});

test("the tab is derived, not synchronised", () => {
  /* An effect that pushed openTab into state would leave one render where the
     sidebar and the page disagreed, and would fight anybody who clicked a tab
     at the wrong moment. The click is stamped with the entry it was made
     under instead, so arriving from a different entry resets it by itself. */
  assert.match(page, /const tab = picked && picked\.from === openTab \? picked\.tab : requestedTab;/);
  assert.match(page, /const setTab = \(next: EngineeringTab\) => setPicked\(\{ from: openTab, tab: next \}\);/);
});

test("the tabs themselves still work on their own", () => {
  // The sidebar decides where you arrive, not where you may go next.
  assert.match(page, /onClick=\{\(\) => setTab\("structure"\)\}/);
  assert.match(page, /onClick=\{\(\) => setTab\("dashboard"\)\}/);
});
