/* Larsa Control — optional approval chains, rank-based routing, and the
 * Points chain.
 *
 * What changed and why it must never quietly change back:
 *
 * 1. A chain is OPTIONAL. Every account used to be seeded with a hardwired
 *    default approver ("u1") and submitRequest fell back to the manager or
 *    that same id — so a Super Admin's leave request could land on a junior
 *    engineer's desk, and "no chain" was not a state the system allowed.
 *    Hardcoded user ids as routing defaults are exactly the class of bug the
 *    production mandate forbids.
 *
 * 2. Chainless requests follow the RANK RULE: any authorized approver at or
 *    above the requester's rank may decide, and at the very top of the
 *    ladder — where that audience is empty — the request approves itself,
 *    honestly recorded as automatic. Rank derives from ROLE_PRESETS, the one
 *    role ladder the app already maintains, so there is no second seniority
 *    table to drift.
 *
 * 3. The third chain type is POINTS. It governs who accepts a person's
 *    submitted points — decided entry by entry, whenever they are added, so
 *    daily, weekly and ad-hoc submissions all travel the same path. The old
 *    "Performance" tab configured a ghost weekly request that decided
 *    nothing; legacy chains saved under that key are still read, and are
 *    settled onto the Points key the next time they are saved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const engineRaw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
/* The engine app lives as a JSON-encoded string inside the bundler template
   script; decode it so assertions read the code people actually run. */
const engineTpl = engineRaw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(engineTpl, "the engine bundler template line could not be found");
const engine = JSON.parse(engineTpl);

// ------------------------------------------------------------ the ladder
test("rank derives from ROLE_PRESETS — one ladder, no second table", () => {
  assert.match(page, /const at = ROLE_PRESETS\.indexOf\(String\(user\?\.access \|\| ""\)\);/);
  assert.match(page, /return at < 0 \? 0 : ROLE_PRESETS\.length - at;/);
  /* The engine cannot import page.tsx, so it carries a copy — which is only
     safe while the two ladders agree, and this is the assertion that keeps
     them agreeing. */
  const presets = page.match(/const ROLE_PRESETS = \[([\s\S]*?)\];/);
  assert.ok(presets, "ROLE_PRESETS could not be found");
  const native = [...presets[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const ladder = engine.match(/const RANK_LADDER=\[([^\]]*)\]/);
  assert.ok(ladder, "the engine RANK_LADDER could not be found");
  const copy = [...ladder[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(copy, native, "engine RANK_LADDER must equal ROLE_PRESETS, in order");
});

test("chainFor is the one reader of flowConfig, legacy Points key included", () => {
  assert.match(page, /function chainFor\(\s*\n\s*store: Record<string, unknown> \| null,/);
  assert.match(page, /const steps = own\[type\] \|\| \(type === "Points" \? own\.Performance : undefined\) \|\| \[\];/);
});

// ------------------------------------------------- chains are optional now
test("no seeded default chain, in the app or the engine", () => {
  // The old seed hardwired one account id as everybody's approver.
  assert.doesNotMatch(page, /Leave: \["u1"\]/);
  assert.doesNotMatch(page, /\[managerId \|\| "u1"\]/);
  /* Engine: the only 'u1' fallbacks left must live inside the demo seed
     fixture (used solely on a blank install, with demo users). Every live
     submit path reads the configured chain or travels chainless. */
  assert.doesNotMatch(engine, /\?\.Leave\|\|\['u1'\]/);
  assert.doesNotMatch(engine, /\?\.Leave \|\| \['u1'\]/);
  assert.doesNotMatch(engine, /\?\.\[uid\]\?\.Leave \|\| \['u1'\]/);
  assert.doesNotMatch(engine, /\?\.Schedule\|\|\['u1'\]/);
  assert.doesNotMatch(engine, /\?\.Performance\|\|\['u1'\]/);
  assert.doesNotMatch(engine, /\(state\.flowConfig\[currentUser\.id\]\?\.Leave\) \|\| \['u1'\]/);
  assert.match(engine, /state\.flowConfig\[currentUser\.id\]\?\.Leave\|\|\[\]/);
  assert.match(engine, /state\.flowConfig\[currentUser\.id\]\?\.Schedule\|\|\[\]/);
  assert.match(engine, /const flow = state\.flowConfig\?\.\[uid\]\?\.Leave \|\| \[\];/);
  // Engine-created users get no seeded chain either.
  assert.doesNotMatch(engine, /state\.flowConfig\[u\.id\]=\{Leave:\['u1'\]/);
});

test("saving an empty chain clears it instead of being refused", () => {
  const save = page.slice(page.indexOf("const saveApprovalFlow = useCallback"), page.indexOf("Fix the figures on a points entry"));
  assert.doesNotMatch(save, /An approval flow needs at least one approver/);
  assert.match(save, /if \(clean\.length\) own\[type\] = clean;\s*\n\s*else delete own\[type\];/);
  // Saving or clearing Points retires the legacy key so it cannot resurrect.
  assert.match(save, /if \(type === "Points"\) delete own\.Performance;/);
  // Chain steps can only be people at or above the employee's rank.
  assert.match(save, /rankOf\(row\) >= rankOf\(employee\)/);
  // Same rules where the engine's own setup card saves the same store.
  assert.match(engine, /if\(steps\.length\)state\.flowConfig\[uid\]\[typ\]=steps;else delete state\.flowConfig\[uid\]\[typ\];if\(typ==='Points'\)delete state\.flowConfig\[uid\]\.Performance;/);
  assert.match(engine, /rankOf\(u\)>=rankOf\(emp\)/);
});

test("a save can never SILENTLY become a deletion", () => {
  /* The validity filters (self, duplicate, inactive, below rank) used to be
     able to reduce a picked chain to nothing, and the save then deleted the
     chain with a cheerful toast — "we tried to update the approval flow and
     it got deleted." Deleting is now only what an explicitly EMPTY submission
     means; a non-empty submission that filters to nothing is refused with the
     reason, and partial drops are named in the confirmation. */
  const save = page.slice(page.indexOf("const saveApprovalFlow = useCallback"), page.indexOf("Fix the figures on a points entry"));
  assert.match(save, /const requested = steps\.filter\(Boolean\);/);
  assert.match(save, /if \(requested\.length && !clean\.length\) \{/);
  assert.match(save, /The chain was left as it was\./);
  assert.match(save, /left as it was\.`\);\s*\n\s*return false;/);
  assert.match(save, /const dropped = requested/);
  // The engine's setup card follows the same rule…
  assert.match(engine, /if\(picked\.length&&!steps\.length\)\{toast\(/);
  assert.match(engine, /Nothing was changed\./);
  // …and no longer opens blank over an existing chain: it loads the saved
  // steps (Points reads the legacy 'Performance' key too), re-syncs when the
  // person or type changes, and only offers approvers the save would accept.
  assert.match(engine, /function flowChainOf\(uid,typ\)\{let own=\(state\.flowConfig\|\|\{\}\)\[uid\]\|\|\{\};let c=own\[typ\]\|\|\(typ==='Points'\?own\.Performance:null\)\|\|\[\];/);
  assert.match(engine, /function syncFlowEditor\(\)\{/);
  assert.match(engine, /id="flowEmp" onchange="syncFlowEditor\(\)"/);
  assert.match(engine, /id="flowType" onchange="syncFlowEditor\(\)"/);
  assert.match(engine, /\$\{flowEditor\(\)\}<\/div>\n <\/div>`;syncFlowEditor\(\)\}/);
});

// ------------------------------------------------------- rank-based routing
test("chainless requests route to approvers at or above the requester's rank", () => {
  const submit = page.slice(page.indexOf("const submitRequest = useCallback"), page.indexOf("Attendance corrections: a forgotten clock"));
  assert.match(submit, /&& rankOf\(row\) >= rankOf\(actor\)/);
  // Nobody outranks the requester: recorded and auto-approved on the spot.
  assert.match(submit, /const autoApproved = !flow\.length && !eligible\.length;/);
  assert.match(submit, /status: autoApproved \? "Approved" : "Pending",/);
  assert.match(submit, /Auto-approved — nobody outranks this account/);
  // An auto-approved request notifies nobody — there is nothing to do.
  assert.match(submit, /if \(!autoApproved\) \{/);
});

test("corrections and late points notify only rank-eligible reviewers", () => {
  const correction = page.slice(page.indexOf("Attendance corrections do NOT walk an approval chain"), page.indexOf("Attendance corrections do NOT walk an approval chain") + 700);
  assert.match(correction, /rankOf\(row\) >= rankOf\(actor\)/);
  const unlock = page.slice(page.indexOf("Late points do NOT walk an approval chain"), page.indexOf("Late points do NOT walk an approval chain") + 1000);
  assert.match(unlock, /rankOf\(entry\) >= rankOf\(user\)/);
});

test("the engine's own decide buttons enforce the same two rules", () => {
  // Chained: only the step it is with (Super Admin excepted).
  assert.match(engine, /if\(flow\[at\]!==currentUser\.id\)\{toast\('This request is with '\+nameOf\(flow\[at\]\)\+' right now\.'\);return false\}/);
  // Chainless: only at or above the requester's rank.
  assert.match(engine, /if\(owner&&rankOf\(currentUser\)<rankOf\(owner\)\)/);
  // Both decision paths run through the one gate.
  assert.match(engine, /function approveReq\(id\)\{let r=state\.approvals\.find\(x=>x\.id===id\);if\(!r\|\|r\.status!=='Pending'\)return;if\(!mayDecide\(r\)\)return;/);
  assert.match(engine, /function rejectReq\(id\)\{let r=state\.approvals\.find\(x=>x\.id===id\);if\(!r\|\|r\.status!=='Pending'\)return;if\(!mayDecide\(r\)\)return;/);
});

// --------------------------------------------------------- the Points chain
test("the Approval Flow screen offers Leave, Schedule and Points", () => {
  assert.match(page, /const FLOW_TYPES = \["Leave", "Schedule", "Points"\] as const;/);
  assert.match(engine, /<option>Leave<\/option><option>Schedule<\/option><option>Points<\/option>/);
});

test("points are accepted per entry, gated by the Points chain or rank", () => {
  const review = page.slice(page.indexOf("const reviewPerformanceRow = ("), page.indexOf("const createDevelopment = ("));
  assert.match(review, /const pointsChain = chainFor\(store, employeeId, "Points"\);/);
  assert.match(review, /\? pointsChain\.includes\(actor\.id\)/);
  assert.match(review, /: \(!owner \|\| rankOf\(actor\) >= rankOf\(owner\)\);/);
  // The review cell mirrors the rule instead of offering a refused button.
  assert.match(page, /const mayReview = Boolean\(viewer && \(isAdmin\(viewer\)/);
});

test("the engine sheet's Approve is gated by the same acceptance rule", () => {
  assert.match(engine, /function mayReviewPerf\(r\)\{/);
  assert.match(engine, /\(state\.flowConfig\?\.\[uid\]\?\.Points\)\|\|\(state\.flowConfig\?\.\[uid\]\?\.Performance\)\|\|\[\]/);
  assert.match(engine, /if\(!mayReviewPerf\(r\)\)\{toast\(/);
  // The button itself only renders for somebody the handler would accept.
  assert.match(engine, /\$\{mayReviewPerf\(r\)\?`<button class="btn small ok" onclick="approvePerf\('\$\{r\.id\}'\)">Approve<\/button>`:''\}/);
  // Accepting stamps who and when, like the native review does.
  assert.match(engine, /r\['Reviewed By'\]=currentUser\.name;r\['Reviewed At'\]=new Date\(\)\.toISOString\(\);/);
});

test("submitting points notifies the deciders; the top of the ladder self-approves", () => {
  const save = page.slice(page.indexOf("const saveMyPoints = ("), page.indexOf("const punchClock = useCallback"));
  assert.match(save, /const pointsChain = chainFor\(store, user\.id, "Points"\);/);
  assert.match(save, /event: "points\.submitted",/);
  assert.match(save, /const autoApproved = submit && roster !== null && !pointsChain\.length && !deciders\.length;/);
  assert.match(save, /"Reviewed By": `\$\{user\.name\} \(auto — top of the ladder\)`,/);
  // The auto path must not also march the entry into a review queue.
  assert.match(save, /\$\{submit && !autoApproved \? "true" : "false"\}&&typeof submitPerformance==="function"/);
});

test("the engine no longer spawns the ghost weekly 'Performance' request", () => {
  /* Approving that request never decided anything — points are accepted entry
     by entry in the review sheet — so it was queue noise with a hardwired
     approver, and the reason the old tab confused people. */
  assert.doesNotMatch(engine, /'Weekly performance points submitted'/);
  assert.match(engine, /function submitPerformance\(\)\{state\.performance\.filter\(r=>r\.uid===currentUser\.id\|\|r\.Engineer===currentUser\.name\)\.forEach\(r=>\{if\(r\.Status==='Draft'\)r\.Status='Submitted'\}\);save\(\);/);
});
