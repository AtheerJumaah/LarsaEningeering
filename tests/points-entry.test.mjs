/* Larsa Control — recording your own points.
 *
 * Three complaints, all from someone actually using the form:
 *   1. Add My Points was reachable only from a Home quick link, so opening
 *      Performance to add points meant going back out to Home to do it.
 *   2. It asked for a "Work Date". The date that matters is the one the work
 *      was FINISHED on — that is what decides which week it counts in.
 *   3. It asked for the estimate (Assigned Points) before the figure the
 *      person actually knows (Total Points).
 *
 * The date and the two point fields keep their storage keys. Renaming
 * workDate or "Submitted Points" would orphan every entry already on record,
 * every week lock and every report that reads them — so what changed is the
 * question being asked, not where the answer is filed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

const form = page.match(/<form className="points-form"[\s\S]*?<\/form>/);
assert.ok(form, "the points form could not be found");
const markup = form[0];

// ------------------------------------------- 1. reachable from Performance
test("Add My Points has its own entry in the Performance sidebar", () => {
  assert.match(page, /staffItems\.find\(\(item\) => item\.id === "staff-dashboard"\)!,\s*\n\s*MY_POINTS_ITEM,/);
});

test("and the Home quick link it used to depend on is still there", () => {
  // Adding a second way in must not remove the first.
  assert.match(page, /const quickCandidateIds = \[[\s\S]*?"my-points",/);
  assert.match(page, /\["quick-clock", "my-points", "staff-development"\]/);   // PIN sessions
});

test("who may open it did not change", () => {
  /* The sidebar filters every entry through the same access check as the rest
     of the nav, and the permission behind my-points is untouched: it is still
     the Submit Performance capability, not a new grant nobody has. */
  assert.match(page, /items: group\.items\.filter\(\(item\) => canOpenInSession\(sessionUser, item, sessionMethod\)\)/);
  assert.match(page, /if \(item\.id === "my-points"\) return hasStaffPermission\(user, "Submit Performance"\);/);
});

// ------------------------------------------------- 2. the completion date
test("the form asks for the Completion Date", () => {
  assert.match(markup, /<label>Completion Date<input required type="date"/);
  assert.doesNotMatch(markup, /Work Date/);
});

test("but it is still filed under the key every record already uses", () => {
  // Same field, same store, same week arithmetic — only the question changed.
  assert.match(markup, /value=\{draft\.workDate\}/);
  assert.match(markup, /update\("workDate", event\.target\.value\)/);
  assert.match(page, /const week = weekOfDate\(draft\.workDate \|\| today\);/);
  assert.match(page, /Date: workDate,/);
});

test("a completion date still cannot be in the future", () => {
  // You cannot finish work tomorrow. max={today} was already right and stays.
  assert.match(markup, /<label>Completion Date<input required type="date" max=\{today\}/);
});

// --------------------------------------------------- 3. total, then assigned
test("Total Points is asked for before Assigned Points", () => {
  const total = markup.indexOf("<label>Total Points");
  const assigned = markup.indexOf("<label>Assigned Points");
  assert.ok(total >= 0 && assigned >= 0, "both fields must still exist");
  assert.ok(total < assigned, "Total Points should come first");
});

test("both fields keep the rules they had", () => {
  // Total is required and at least half a point; the estimate stays optional.
  assert.match(markup, /<label>Total Points<input required type="number" min="0\.5" step="0\.5"[^>]*value=\{draft\.submittedPoints\}/);
  assert.match(markup, /<label>Assigned Points<input type="number" min="0" step="0\.5"[^>]*value=\{draft\.assignedPoints\}/);
  // And the stored keys are the originals, as the file's own comment insists.
  assert.match(page, /"Assigned Points": Number\(draft\.assignedPoints\) \|\| 0,/);
  assert.match(page, /"Submitted Points": Number\(draft\.submittedPoints\) \|\| 0,/);
});

test("nothing else on the form was disturbed", () => {
  for (const field of ["Job Number", "Client Code", "Work Category", "Discipline", "Hours Spent", "Notes"]) {
    assert.match(markup, new RegExp(field), `${field} disappeared from the form`);
  }
  // The closed-week path is the fiddliest part of this screen; leave it alone.
  assert.match(markup, /Reason for the late entry/);
});
