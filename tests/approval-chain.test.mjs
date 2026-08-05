/* Larsa Control — the approval chain, finally enforced.
 *
 * This one was a live authorisation gap, not a rough edge. Every request has
 * carried `flow` (the ordered list of approver ids) and `step` (where it has
 * got to) since flows were added. decideRequest read neither: it checked that
 * the actor holds the approve permission and then resolved the request. Any
 * one approver could close anything, so a two-stage chain was decoration and
 * an administrator configuring one was being told a comforting untruth.
 *
 * The rule now: only the person the request is with may decide it, approving
 * at a non-final step advances rather than closes, and a rejection at any step
 * ends it. The one deliberate exception is written down and audited.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const decide = page.match(/const decideRequest = useCallback[\s\S]*?\}, \[notify, refreshStaffEngine\]\);/);
assert.ok(decide, "decideRequest could not be found");
const body = decide[0];

test("the chain is read from one place, by both the handler and the screen", () => {
  /* Two copies of this arithmetic would eventually disagree, and the screen
     would offer a button the handler refuses. */
  assert.match(page, /function requestStage\(record: LeaveRequest\): \{ holder: string \| null; step: number; total: number \}/);
  assert.match(body, /const \{ holder: waitingOn, step \} = requestStage\(record\);/);
  assert.match(page, /const \{ holder, step, total \} = requestStage\(row\);/);
});

test("somebody who is not the current approver is refused", () => {
  assert.match(body, /const overriding = Boolean\(waitingOn && waitingOn !== actor\.id\);/);
  assert.match(body, /if \(overriding && !isAdmin\(actor\)\) \{/);
  assert.match(body, /This request is with \$\{holder\.name\} at the moment\./);
  // Refused, not silently ignored.
  assert.match(body, /at the moment\."\);\s*\n\s*return false;/);
});

test("the permission check is still there — the chain is on top of it", () => {
  // Being named in a flow does not grant the capability to approve.
  assert.match(body, /if \(!actor \|\| !approvalsItem \|\| !hasItemPermission\(actor, approvalsItem, "approve"\)\) \{/);
});

test("approving at a non-final step advances instead of closing", () => {
  assert.match(body, /const advancing = status === "Approved" && flow\.length > step \+ 1;/);
  assert.match(body, /const settled: "Approved" \| "Rejected" \| "Pending" = advancing \? "Pending" : status;/);
  assert.match(body, /step: advancing \? step \+ 1 : step,/);
});

test("a rejection ends the request wherever it stands", () => {
  /* advancing is only ever true for "Approved", so a Rejected decision always
     settles as Rejected. Every approver is a veto. */
  assert.match(body, /status === "Approved" && flow\.length > step \+ 1/);
});

test("nothing is written into the records until the chain finishes", () => {
  /* This is the half that would actually corrupt data: a mid-chain approval
     used to be indistinguishable from a final one, so an attendance
     correction or a late points entry would be written on the first yes. */
  assert.match(body, /if \(settled === "Approved" && CORRECTIONS\.includes\(String\(record\.type\)\) && !updated\.materialised\)/);
  assert.match(body, /if \(settled === "Approved" && record\.type === "Points Unlock" && record\.entry && !updated\.materialised\)/);
  assert.doesNotMatch(body, /if \(status === "Approved" &&/);
});

test("a request still moving names no decider", () => {
  // "Decided by" on a request that is not decided is a lie on the employee's copy.
  assert.match(body, /\.\.\.\(advancing \? \{\} : \{ decidedBy: actor\.name, decidedAt: stamp \}\),/);
});

test("and the next approver is told, not the employee", () => {
  assert.match(body, /if \(advancing\) \{\s*\n\s*const next = \(store\.users as StaffUser\[\]\)\.find\(\(row\) => row\.id === flow\[step \+ 1\]\);/);
  assert.match(body, /title: `\$\{record\.type\} request needs your decision`/);
  assert.match(body, /\} else if \(employee\) \{/);
});

test("every step is recorded, including which step it was", () => {
  assert.match(body, /action: advancing \? `Approved \(step \$\{step \+ 1\} of \$\{flow\.length\}\)` : status,/);
});

// ----------------------------------------------- the one deliberate exception
test("an administrator can still act, and it is written down as an override", () => {
  /* A chain containing somebody who has left the company would otherwise block
     for ever. The escape hatch is real, so it is audited rather than hidden. */
  assert.match(body, /note: overriding \? `\$\{note \? `\$\{note\} · ` : ""\}Decided by an administrator out of turn` : note,/);
});

// ------------------------------------------------------- existing requests
test("a request with no chain keeps the old behaviour", () => {
  /* Every request created before flows existed has no flow. Enforcing a chain
     that is not there would strand all of them as undecidable. */
  assert.match(page, /if \(!flow\.length\) return \{ holder: null, step: 0, total: 0 \};/);
  assert.match(page, /const mine = !holder \|\| holder === viewer\?\.id;/);
});

test("a corrupt step index cannot point outside the chain", () => {
  // Clamped both ways, so a bad stored value reads as a real approver.
  assert.match(page, /const step = Math\.max\(0, Math\.min\(Number\(record\.step\) \|\| 0, flow\.length - 1\)\);/);
});

// ------------------------------------------------------------- the screen
test("the queue shows whose desk a request is on instead of a dead button", () => {
  assert.match(page, /return <small>With \{who\?\.name \|\| "another approver"\}\{total > 1 \? ` · step \$\{step \+ 1\} of \$\{total\}` : ""\}<\/small>;/);
  assert.match(page, /\{total > 1 && step \+ 1 < total \? "Approve · next step" : "Approve"\}/);
});

test("late points and attendance corrections skip the chain: one authorized reviewer decides", () => {
  /* A points figure or a wrong clock-in is a records question, not a leave
     question. Both are created with an EMPTY flow, which is the single-step
     path decideRequest has always enforced for chainless requests: anyone
     holding the approve grant may decide, and the first decision is final —
     it settles the request and materialises the record at once. Leave and
     schedule requests keep their configured chains untouched. */
  const unlockAt = page.indexOf("Late points do NOT walk an approval chain");
  const correctionAt = page.indexOf("Attendance corrections do NOT walk an approval chain");
  assert.ok(unlockAt > 0, "the late-points rationale must be written down");
  assert.ok(correctionAt > 0, "the corrections rationale must be written down");
  // Both creations carry an empty flow…
  assert.match(page.slice(unlockAt, unlockAt + 900), /const flow: string\[\] = \[\];/);
  assert.match(page.slice(correctionAt, correctionAt + 1200), /flow: \[\],/);
  // …and notify exactly the people granted approve access, never a chain.
  const reviewerGate = /hasItemPermission\((?:entry|row), approvalsGate, "approve"\)/g;
  assert.ok((page.match(reviewerGate) || []).length >= 2, "reviewers must be selected by the approve grant");
  // Leave and schedule requests still read the configured chain.
  assert.match(page, /const configured = flowConfig\[actor\.id\]\?\.\[draft\.type\];/);
});
