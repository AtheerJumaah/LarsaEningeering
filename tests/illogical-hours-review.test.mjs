import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const flows = await readFile(new URL("../lib/approval-flow.ts", import.meta.url), "utf8");

test("employees are visibly prompted to correct implausible attendance", () => {
  assert.match(page, /const attentionSessions = useMemo/);
  assert.match(page, /session\.stale \|\| session\.unclosed \|\| session\.long/);
  assert.match(page, /Hours need attention/);
  assert.match(page, /Review and trim my hours/);
  assert.match(page, /It is not counted until you correct it/);
});

test("a self-trim can optionally request leader review without rewriting hours twice", () => {
  const trim = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  assert.match(trim, /requestReview = false/);
  assert.match(trim, /requestReview && uid === actor\.id/);
  assert.match(trim, /type: "Hours Review"/);
  assert.match(trim, /chainFor\(store, actor\.id, "Hours Review"\)/);
  assert.doesNotMatch(trim, /record\.type === "Hours Review"[\s\S]*?store\.logs/);
  assert.match(page, /Ask my leader to review/);
  assert.match(flows, /"Hours Review"/);
});

test("the disliked freeform canvas is removed", async () => {
  const structure = await readFile(new URL("../app/OrgStructure2.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(structure, /Freeform canvas|s2-freeform|diagramPositions/);
  assert.match(structure, /Interactive visual organization chart/);
});
