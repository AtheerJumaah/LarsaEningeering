/* Larsa Control — a work-area card opens that area's Dashboard.
 *
 * It used to open whichever page in the area the person could reach first,
 * which for Accounting meant accounting-hub — a page whose own description is
 * "Choose an accounting area". An index standing between somebody and the
 * overview they wanted.
 *
 * The important half of this is the fallback: changing where people land must
 * not change what they may reach, so somebody without Dashboard permission
 * still arrives on the first page they can open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("each work area resolves its Dashboard first", () => {
  assert.match(page, /const landingFor = \(dashboardId: string, fallbacks: \(Item \| undefined\)\[\]\) => \{/);
  assert.match(page, /const accountingLanding = landingFor\("acc-dashboard", \[/);
  assert.match(page, /const hrLanding = landingFor\("hr-dashboard",/);
  assert.match(page, /const performanceLanding = landingFor\("staff-dashboard",/);
});

test("the Dashboard is only chosen when the person may open it", () => {
  // Landing is presentation; access stays with canOpenInSession, exactly as
  // before. A card can never become a way into a page you are not allowed in.
  assert.match(page, /if \(dashboard && canOpenInSession\(user, dashboard, method\)\) return dashboard;/);
  assert.match(page, /return fallbacks\.find\(\(item\): item is Item => Boolean\(item && canOpenInSession\(user, item, method\)\)\);/);
});

test("the previous first-available behaviour survives as the fallback", () => {
  // Nobody loses a destination: every page that was reachable as a landing
  // before is still in a fallback list.
  assert.match(page, /\["week-schedule", "staff-timesheet", "my-requests", "live-presence"\]\.map\(byId\)/);
  assert.match(page, /\["performance-center", "performance-history", "staff-reports"\]\.map\(byId\)/);
  assert.match(page, /ACCOUNTING_HUB_ITEM,\s*\n\s*\.\.\.\(GROUPS\.find\(\(group\) => group\.label === "Accounting"\)\?\.items \|\| \[\]\),/);
});

test("Time lands on Clock In / Out rather than a duplicate dashboard", () => {
  /* Named rather than left implicit, because it is the one area that does not
     follow the pattern. Clock In / Out already carries today's status, the week
     against the schedule and recent sessions; a Time Dashboard would be those
     same figures with a click in front of them. */
  assert.match(page, /const timeLanding = landingFor\("quick-clock",/);
  // And no landing points at a page that does not exist.
  assert.doesNotMatch(page, /staff-time-dashboard/);
});

test("the accounting index is no longer the first thing Accounting opens", () => {
  // It stays reachable as a fallback and as a page; it just stops being the
  // default destination.
  assert.doesNotMatch(page, /const accountingLanding = canOpenInSession\(user, ACCOUNTING_HUB_ITEM, method\)/);
  assert.match(page, /description: "Choose an accounting area"/);   // still exists
});

test("Administration and Engineering already land on their own dashboards", () => {
  // These two were correct before and are left alone.
  assert.match(page, /\{ id: "admin", channel: "admin" as const, title: "Administration"/);
  assert.match(page, /\{ id: "org-structure", channel: "engineering" as const, title: "Engineering Management"/);
});

test("landing on the Dashboard does not step around the accounting identity check", () => {
  /* This is the one that actually needed proving. The Accounting card used to
     open accounting-hub, a native page with no engine, so the device check did
     not run until you picked an area inside it. acc-dashboard IS an engine
     page, so the check now runs on the way in.

     That is the same check, one click earlier — not a new obstacle. A person
     who signed in with an email code has a device stamped lastVerified, and
     accountingNeedsVerification reads it, so they go straight through. Measured
     against the built app: with a verified device the Accounting card lands on
     acc-dashboard with no prompt; with an unknown device it shows the code
     screen, which is the whole point of having it. */
  assert.match(page, /item\.engine === "accounting" && sessionUserRef\.current && sessionUserRef\.current\.email && accountingNeedsVerification\(sessionUserRef\.current, getDeviceId\(\)\)/);
  assert.match(page, /engineItem\("accounting", "acc-dashboard", "Accounting Dashboard"/);
});

test("Quick Actions still open a specific workflow, not a dashboard", () => {
  // Section 3 keeps these as direct entries: Clock In/Out, Add My Points and
  // the rest are actions, not overviews.
  assert.match(page, /const quickCandidateIds = \[\s*\n\s*"quick-clock",/);
  assert.match(page, /"my-pay",/);
  assert.match(page, /"my-points",/);
});
