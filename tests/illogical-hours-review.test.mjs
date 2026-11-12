import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const flows = await readFile(new URL("../lib/approval-flow.ts", import.meta.url), "utf8");

test("employees are visibly prompted to correct implausible attendance", () => {
  assert.match(page, /const allAttentionSessions = useMemo/);
  assert.match(page, /const attentionSessions = useMemo/);
  assert.match(page, /session\.stale \|\| session\.unclosed \|\| session\.long/);
  assert.match(page, /Hours need attention/);
  assert.match(page, /Illogical hours period/);
  assert.match(page, /Nothing was deleted/);
  assert.match(page, /All history/);
  assert.match(page, /It is not counted until you correct it/);
});

test("a self-trim follows the saved approval rule and flags immediate changes for review", () => {
  const trim = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  assert.match(trim, /attendanceApprovalPolicy\(\)/);
  assert.match(trim, /approvalPolicy\?\.trim_hours_requires_approval/);
  assert.match(trim, /type: "Trim Hours"/);
  assert.match(trim, /type: "Hours Review"/);
  assert.match(trim, /chainFor\(store, actor\.id, "Hours Review"\)/);
  assert.doesNotMatch(trim, /record\.type === "Hours Review"[\s\S]*?store\.logs/);
  assert.match(page, /Your leader receives a review flag when approval is off/);
  assert.match(flows, /"Hours Review"/);
});

test("the disliked freeform canvas is removed", async () => {
  const structure = await readFile(new URL("../app/OrgStructure2.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(structure, /Freeform canvas|s2-freeform|diagramPositions/);
  assert.match(structure, /Interactive visual organization chart/);
});
