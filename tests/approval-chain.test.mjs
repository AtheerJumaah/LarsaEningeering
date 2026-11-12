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
  assert.match(body, /const executiveDelegate = Boolean\(waitingOn && waitingOn !== actor\.id[\s\S]*?canActForApprovalHolder/);
  assert.match(body, /const overriding = Boolean\(waitingOn && waitingOn !== actor\.id && !executiveDelegate\);/);
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
  assert.match(body, /nextUncoveredApprovalStep\(store\.users as StaffUser\[\], approvalOrg, flow, step, actor\.id, isAdmin\(actor\)\)/);
  assert.match(body, /const advancing = nextStep !== null;/);
  assert.match(body, /const settled: "Approved" \| "Rejected" \| "Pending" = advancing \? "Pending" : status;/);
  assert.match(body, /step: advancing \? nextStep : step,/);
});

test("a rejection ends the request wherever it stands", () => {
  /* advancing is only ever true for "Approved", so a Rejected decision always
     settles as Rejected. Every approver is a veto. */
  assert.match(body, /const nextStep = status === "Approved" && !record\.reviewOnly/);
});

test("provisional attendance is confirmed without duplication only when the chain finishes", () => {
  assert.match(body, /const correctionPlan = settled === "Approved" && CORRECTIONS\.includes\(String\(record\.type\)\)/);
  assert.match(body, /if \(correctionPlan\?\.ok && !updated\.materialised && !updated\.materialized\)/);
  assert.match(body, /log\.provisionalReview = false;/);
  assert.match(body, /if \(settled === "Approved" && record\.type === "Points Unlock" && record\.entry && !updated\.materialised\)/);
  assert.doesNotMatch(body, /if \(status === "Approved" &&/);
});

test("rejecting provisional time reverses it and prevents ledger restoration", () => {
  assert.match(body, /\.filter\(\(log\) => log\.correctionId !== record\.id\);/);
  assert.match(body, /markLogsRemoved\(store as \{ removedLogIds\?: string\[\] \}, removed\);/);
  assert.match(body, /updated\.provisionalReversedAt = stamp;/);
});

test("a request still moving names no decider", () => {
  // "Decided by" on a request that is not decided is a lie on the employee's copy.
  assert.match(body, /\.\.\.\(advancing \? \{\} : \{ decidedBy: actor\.name, decidedAt: stamp \}\),/);
});

test("and the next approver is told, not the employee", () => {
  assert.match(body, /if \(advancing\) \{\s*\n\s*const next = \(store\.users as StaffUser\[\]\)\.find\(\(row\) => row\.id === flow\[nextStep\]\);/);
  assert.match(body, /title: `\$\{record\.type\} request needs your decision`/);
  assert.match(body, /\} else if \(employee\) \{/);
});

test("every step is recorded, including which step it was", () => {
  assert.match(body, /action: record\.reviewOnly && status === "Approved" \? "Reviewed" : advancing \? `Approved \(step \$\{step \+ 1\} of \$\{flow\.length\}\)` : status,/);
});

// ----------------------------------------------- the one deliberate exception
test("an administrator can still act, and it is written down as an override", () => {
  /* A chain containing somebody who has left the company would otherwise block
     for ever. The escape hatch is real, so it is audited rather than hidden. */
  assert.match(body, /Decided by an administrator out of turn/);
  assert.match(body, /under higher organizational authority/);
});

// ------------------------------------------------------- existing requests
test("a request with no chain stays decidable — by rank, not by anybody", () => {
  /* Every request created before flows existed has no flow, and chains are
     now optional besides. Chainless requests must stay decidable (an approver
     at or above the requester's rank, Super Admin always), and the screen
     mirrors that rule instead of offering everyone a button. */
  assert.match(page, /if \(!flow\.length\) return \{ holder: null, step: 0, total: 0 \};/);
  assert.match(page, /const mine = holder\s*\n\s*\? canActForApprovalHolder\(users, approvalOrg, viewer\?\.id, holder\)\s*\n\s*: Boolean\(viewer && \(!person \|\| rankOf\(viewer\) >= rankOf\(person\)\)\);/);
  // And the handler itself refuses a decision from below the requester's rank.
  const decideBody = page.slice(page.indexOf("const decideRequest = useCallback"), page.indexOf("const saveGrowthStore"));
  assert.match(decideBody, /if \(!waitingOn && !isAdmin\(actor\)\) \{/);
  assert.match(decideBody, /if \(requester && rankOf\(actor\) < rankOf\(requester\)\) \{/);
});

test("a corrupt step index cannot point outside the chain", () => {
  // Clamped both ways, so a bad stored value reads as a real approver.
  assert.match(page, /const step = Math\.max\(0, Math\.min\(Number\(record\.step\) \|\| 0, flow\.length - 1\)\);/);
});

// ------------------------------------------------------------- the screen
test("the queue shows whose desk a request is on instead of a dead button", () => {
  assert.match(page, /return <small>With \{who\?\.name \|\| "another approver"\}\{total > 1 \? ` · step \$\{step \+ 1\} of \$\{total\}` : ""\}<\/small>;/);
  assert.match(page, /nextHolderStep !== null \? "Approve · next step" : "Approve request"/);
});

test("points and attendance corrections use the editable approval flow", () => {
  /* Corrections are requests just like leave and schedule. The route is
     derived from the structure by default, can be edited in Approval Flow,
     and only falls back to rank-authorized reviewers when it was explicitly
     cleared or no hierarchy exists. */
  assert.match(page, /ensureStoreApprovalFlows\(store\);/);
  assert.match(page, /const configured = chainFor\(store, actor\.id, draft\.kind\);/);
  assert.match(page, /flow,\s*\n\s*step: 0,/);
  assert.match(page, /const configured = chainFor\(store, user\.id, "Points"\);/);
  assert.match(page, /const flow = configured\.length \? configured : \[\];/);
  assert.match(page, /event: "clock\.correction",/);
  assert.match(page, /event: "points\.unlock",/);
  assert.match(page, /provisionalReview: true,/);
  assert.match(page, /const reviseAttendanceRequest = useCallback/);
});

test("a request is only announced to the approver it is actually with", () => {
  /* Naming somebody in a chain is not the same as it being their turn. Every
     approver used to be notified the moment a request was raised, and asked to
     act on something decideRequest would refuse them — only the current holder
     may decide. The later steps are told when the request reaches them, which
     decideRequest already does when it advances. */
  const submit = page.slice(page.indexOf("const submitRequest = useCallback"), page.indexOf("Attendance corrections: a forgotten clock"));
  assert.match(submit, /const approvers = flow\.length\s*\n\s*\? \(store\.users as StaffUser\[\]\)\.filter\(\(row\) => row\.id === flow\[0\]\)\s*\n\s*: eligible;/);
  assert.doesNotMatch(submit, /filter\(\(row\) => flow\.includes\(row\.id\)\)/);
  // The forced default chain is gone: no manager fallback, no hardwired id.
  assert.doesNotMatch(submit, /\[managerId \|\| "u1"\]/);
  assert.doesNotMatch(submit, /"u1"/);
  // The hand-off to the next approver still happens inside the decision.
  assert.match(body, /if \(advancing\) \{\s*\n\s*const next = \(store\.users as StaffUser\[\]\)\.find\(\(row\) => row\.id === flow\[nextStep\]\);/);
});

test('"need attention" counts only what is genuinely waiting on this person', () => {
  /* The home badge counted anyone named anywhere in a chain, so approvers two
     and three were told a request needed them while it sat with approver one.
     It now mirrors the rule the decision handler enforces, and requires the
     approve grant — a chainless points or clock correction belongs to whoever
     holds it, nobody else. */
  const summary = page.slice(page.indexOf("const queue = !mayApprove"), page.indexOf("const queue = !mayApprove") + 700);
  assert.match(summary, /if \(request\.status !== "Pending" \|\| request\.uid === viewer\.id\) return false;/);
  assert.match(summary, /if \(!chain\.length\) \{\s*\n\s*const requester = users\.find\(\(user\) => user\.id === request\.uid\);\s*\n\s*return !requester \|\| rankOf\(viewer\) >= rankOf\(requester\);/);
  assert.match(summary, /return canActForApprovalHolder\(users, approvalOrg, viewer\.id, chain\[at\]\);/);
  assert.match(page, /const mayApprove = Boolean\(approvalsGate && hasItemPermission\(viewer, approvalsGate, "approve"\)\);/);
  // The old "anywhere in the chain" test is gone for good.
  assert.doesNotMatch(page, /&& request\.flow\.includes\(viewer\.id\)\)\.length;/);
});
