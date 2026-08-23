/* Larsa Control — what belongs in Time, in Performance, and in HR.
 *
 * One group used to be called "Timeclock & Performance" and held both: clocking
 * and schedules next to points and reviews. The two are different jobs done by
 * different people at different moments, and mixing them meant somebody looking
 * for last week's hours scrolled past performance reviews to find them.
 *
 * These tests pin the split. They are deliberately about ORDER and MEMBERSHIP
 * only — no page was renamed, no permission changed, nothing was deleted. The
 * riskiest thing about a reorganisation is that it quietly drops something, so
 * most of what follows checks that nothing did.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

/* The sidebar for an area is built from channelGroups, so that is what to read
   to know what somebody actually sees, in what order. */
function channelItems(name) {
  const block = page.match(new RegExp(`\\n    ${name}: \\{[\\s\\S]*?\\n    \\},\\n`));
  assert.ok(block, `no ${name} channel group found`);
  return block[0];
}

// ------------------------------------------------------- Time & Attendance
test("Time & Attendance holds everything about hours, in working order", () => {
  const time = channelItems("time");
  const order = [...time.matchAll(/QUICK_CLOCK_ITEM|WEEK_SCHEDULE_ITEM|"staff-timesheet"|REQUESTS_ITEM|PRESENCE_ITEM/g)].map((m) => m[0]);
  assert.deepEqual(order, [
    "QUICK_CLOCK_ITEM",     // clock
    "WEEK_SCHEDULE_ITEM",   // the week you are clocking against
    '"staff-timesheet"',    // what it adds up to
    "REQUESTS_ITEM",        // what changes it
    "PRESENCE_ITEM",        // who is in right now
  ]);
});

// ----------------------------------------------------------- Performance
test("Performance opens on its Dashboard and holds no attendance pages", () => {
  const perf = channelItems("performance");
  const ids = [...perf.matchAll(/"(staff-[a-z]+|performance-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    "staff-dashboard",      // Dashboard
    "performance-center",   // Points & approvals
    "staff-performance",
    "performance-history",  // Reviews & recognition
    "staff-reports",        // Reports
  ]);
  // The things that used to blur the two areas together.
  for (const stray of ["quick-clock", "week-schedule", "staff-clock", "staff-schedule", "staff-timesheet", "live-presence", "my-requests"]) {
    assert.doesNotMatch(perf, new RegExp(`"${stray}"`), `${stray} is attendance and does not belong in Performance`);
  }
});

// ------------------------------------------------------------ HR & Skills
test("the Development Portal sits with skills, which is the same subject", () => {
  assert.match(page, /engineItem\("hr", "hr-matrix"[\s\S]{0,120}?DEVELOPMENT_ITEM,/);
  assert.match(page, /if \(item\.id === "staff-development"\) return "hr";/);
  // And is no longer listed under Performance in either place it is listed.
  const perf = channelItems("performance");
  assert.doesNotMatch(perf, /staff-development/);
});

// --------------------------------------------------------- nothing lost
test("moving the portal changed where it lives, not who may open it", () => {
  /* Every one of these reads permissions off DEVELOPMENT_ITEM by id. Group
     membership has never been part of that check, and this proves the checks
     are all still standing after the move. */
  for (const action of ["add", "edit", "approve", "delete"]) {
    assert.match(page, new RegExp(`hasItemPermission\\(actor, DEVELOPMENT_ITEM, "${action}"\\)`));
  }
  assert.match(page, /hasItemPermission\(viewer, DEVELOPMENT_ITEM, "export"\)/);
});

test("the access tree still lists every page, the portal included", () => {
  /* The owner's line was that Users & Access keeps ALL pages and ALL granular
     permissions. The portal was removed from the Performance branch only
     because the HR branch is built from GROUPS and now carries it — so it
     appears once, not zero times and not twice. */
  const tree = page.match(/label: "Performance & Workboard",[\s\S]*?\n  \},/);
  assert.ok(tree);
  assert.doesNotMatch(tree[0], /DEVELOPMENT_ITEM/);
  assert.match(page, /label: "HR & Skills",\s*\n\s*items: GROUPS\.find\(\(group\) => group\.label === "HR & Skills"\)!\.items,/);

  // The rest of the Performance branch is untouched, review and targets too.
  for (const entry of ["PERFORMANCE_CENTER_ITEM", "PERFORMANCE_REVIEW_ITEM", "PERFORMANCE_TARGETS_ITEM", "PERFORMANCE_HISTORY_ITEM"]) {
    assert.match(tree[0], new RegExp(entry));
  }
});

test("the engine's own clock and schedule pages are still registered", () => {
  /* They are not in the sidebar — the native Clock In / Out and Weekly Schedule
     stand in for them — but they must stay in ITEMS, because permissions and
     the system check both walk that list. */
  for (const id of ["staff-clock", "staff-live", "staff-schedule", "staff-rules", "staff-backup"]) {
    assert.match(page, new RegExp(`"${id}"`), `${id} disappeared from the registry`);
  }
});
