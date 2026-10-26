import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Structure 2 is additive and leaves the original Structure mounted separately", async () => {
  const [page, structure2] = await Promise.all([read("app/page.tsx"), read("app/OrgStructure2.tsx")]);
  assert.match(page, /label: "Structure", description: "Departments, teams, and access"/);
  assert.match(page, /label: "Structure 2", description: "Visual team builder and assignment matrix"/);
  assert.match(page, /tab === "structure" && <OrgStructure/);
  assert.match(page, /tab === "structure2" && <OrgStructure2/);
  assert.match(structure2, /effectiveOrg\(users\)/);
  assert.match(structure2, /writeOrg\(draft\)/);
  assert.match(structure2, /pushSyncedKeyNow\("larsaStaffV8"\)/);
});

test("Structure 2 supports overlapping roles, drag assignment, matrix review, and explicit saving", async () => {
  const structure2 = await read("app/OrgStructure2.tsx");
  assert.match(structure2, /Drag the same person into several teams or leadership roles/);
  assert.match(structure2, /kind="head"/);
  assert.match(structure2, /kind="lead"/);
  assert.match(structure2, /kind="member"/);
  assert.match(structure2, /Assignment matrix/);
  assert.match(structure2, /Additional reporting lines/);
  assert.match(structure2, /Save changes/);
  assert.match(structure2, /disabled=\{!draft \|\| saving\}/);
});
